import { Injectable, Logger, Optional } from '@nestjs/common';
import { DeduplicationAdapter } from './deduplication-adapter.interface';
import {
  EntityType,
  FieldDiff,
  FieldResolutionStrategy,
  RuleEvaluation,
} from '../deduplication.types';
import { ProjectResponse, ProjectStatusEnum } from '../../projects/interfaces/project.interface';
import { ProjectsService } from '../../projects/projects.service';
import {
  canonicalNormalize,
  computeCanonicalDigest,
  jaccardTrigramSimilarity,
  levenshteinSimilarity,
} from '../similarity-scoring';

@Injectable()
export class ProjectDeduplicationAdapter implements DeduplicationAdapter<ProjectResponse> {
  readonly entityType = EntityType.PROJECT;
  private readonly logger = new Logger(ProjectDeduplicationAdapter.name);

  // In-memory backing store for local/testing override
  private readonly localStore = new Map<string, ProjectResponse>();

  constructor(@Optional() private readonly projectsService?: ProjectsService) {}

  /** Register an entity directly (useful in unit/integration tests and in-memory setups) */
  setEntity(project: ProjectResponse): void {
    this.localStore.set(String(project.id), project);
  }

  async fetchEntities(): Promise<ProjectResponse[]> {
    if (this.localStore.size > 0) {
      return Array.from(this.localStore.values()).filter(
        (p) => p.status !== ProjectStatusEnum.Inactive,
      );
    }
    if (!this.projectsService) return [];
    try {
      const result = await this.projectsService.findAll(1, 100);
      return result.data.filter((p: ProjectResponse) => p.status !== ProjectStatusEnum.Inactive);
    } catch (err: any) {
      this.logger.warn(`Failed to fetch projects from ProjectsService: ${err.message}`);
      return [];
    }
  }

  async getEntity(id: string): Promise<ProjectResponse | null> {
    if (this.localStore.has(id)) {
      return this.localStore.get(id)!;
    }
    if (!this.projectsService) return null;
    try {
      return await this.projectsService.findOne(Number(id));
    } catch {
      return null;
    }
  }

  idOf(entity: ProjectResponse): string {
    return String(entity.id);
  }

  evaluateCandidate(a: ProjectResponse, b: ProjectResponse): { confidence: number; evaluations: RuleEvaluation[] } {
    const evaluations: RuleEvaluation[] = [];

    // Rule 1: Exact IPFS metadata hash / registry document CID match
    const hasHash = Boolean(a.metadataIpfsHash && b.metadataIpfsHash);
    const exactHash = hasHash && a.metadataIpfsHash === b.metadataIpfsHash;
    const score1 = exactHash ? 1.0 : 0.0;
    evaluations.push({
      ruleId: 'EXACT_METADATA_CID',
      ruleName: 'IPFS Metadata Document Hash Match',
      score: score1,
      weight: 0.45,
      threshold: 1.0,
      passed: exactHash,
      details: exactHash ? `Identical CID: ${a.metadataIpfsHash}` : 'CIDs differ or missing',
    });

    // Rule 2: Project name similarity (trigrams and Levenshtein)
    const normNameA = canonicalNormalize(a.name);
    const normNameB = canonicalNormalize(b.name);
    const nameLev = levenshteinSimilarity(normNameA, normNameB);
    const nameJaccard = jaccardTrigramSimilarity(normNameA, normNameB);
    const score2 = Math.max(nameLev, nameJaccard);
    evaluations.push({
      ruleId: 'PROJECT_NAME_SIMILARITY',
      ruleName: 'Canonical Project Title Similarity',
      score: score2,
      weight: 0.35,
      threshold: 0.75,
      passed: score2 >= 0.75,
      details: `Title similarity score: ${score2}`,
    });

    // Rule 3: Jurisdiction and scale proximity (country and totalArea / sequestration estimate)
    let score3 = 0.0;
    const sameCountry =
      canonicalNormalize(a.country) === canonicalNormalize(b.country) &&
      canonicalNormalize(a.country).length > 0;
    if (sameCountry) score3 += 0.5;

    const maxEst = Math.max(a.carbonSequestrationEstimate || 0, b.carbonSequestrationEstimate || 0);
    if (maxEst > 0) {
      const diff = Math.abs(
        (a.carbonSequestrationEstimate || 0) - (b.carbonSequestrationEstimate || 0),
      );
      const ratio = diff / maxEst;
      if (ratio <= 0.1) {
        score3 += 0.5;
      } else if (ratio <= 0.25) {
        score3 += 0.25;
      }
    }
    score3 = Number(score3.toFixed(4));
    evaluations.push({
      ruleId: 'JURISDICTION_AND_SCALE_PROXIMITY',
      ruleName: 'Jurisdiction & Carbon Estimation Scale Proximity',
      score: score3,
      weight: 0.2,
      threshold: 0.6,
      passed: score3 >= 0.6,
      details: `Country match: ${sameCountry}, scale score: ${score3}`,
    });

    // Weighted confidence
    const totalWeight = evaluations.reduce((sum, e) => sum + e.weight, 0);
    const weightedSum = evaluations.reduce((sum, e) => sum + e.score * e.weight, 0);
    const confidence = Number((weightedSum / totalWeight).toFixed(4));

    return { confidence, evaluations };
  }

  computeDiffs(primary: ProjectResponse, secondary: ProjectResponse): FieldDiff[] {
    const fields: (keyof ProjectResponse)[] = [
      'name',
      'status',
      'methodology',
      'country',
      'totalAreaHa',
      'carbonSequestrationEstimate',
      'metadataIpfsHash',
      'ownerAddress',
    ];
    return fields.map((f) => ({
      fieldName: f,
      primaryValue: primary[f] ?? null,
      secondaryValue: secondary[f] ?? null,
      identical: primary[f] === secondary[f],
    }));
  }

  computeMergedState(
    primary: ProjectResponse,
    secondary: ProjectResponse,
    strategies: Record<string, { strategy: FieldResolutionStrategy; manualValue?: any }> = {},
  ): { mergedPrimary: ProjectResponse; mergedSecondary: ProjectResponse } {
    // 1. Carbon Sequestration Estimate
    let mergedEst = primary.carbonSequestrationEstimate;
    const estStrategy = strategies.carbonSequestrationEstimate?.strategy ?? FieldResolutionStrategy.PRIMARY_WINS;
    if (estStrategy === FieldResolutionStrategy.MANUAL) {
      mergedEst = strategies.carbonSequestrationEstimate.manualValue;
    } else if (estStrategy === FieldResolutionStrategy.SECONDARY_WINS) {
      mergedEst = secondary.carbonSequestrationEstimate;
    } else {
      // Default: Highest estimate
      mergedEst = Math.max(
        primary.carbonSequestrationEstimate || 0,
        secondary.carbonSequestrationEstimate || 0,
      );
    }

    // 2. Area
    let mergedArea = primary.totalAreaHa;
    const areaStrategy = strategies.totalAreaHa?.strategy ?? FieldResolutionStrategy.PRIMARY_WINS;
    if (areaStrategy === FieldResolutionStrategy.MANUAL) {
      mergedArea = strategies.totalAreaHa.manualValue;
    } else if (areaStrategy === FieldResolutionStrategy.SECONDARY_WINS) {
      mergedArea = secondary.totalAreaHa;
    } else {
      mergedArea = Math.max(primary.totalAreaHa || 0, secondary.totalAreaHa || 0);
    }

    const mergedPrimary: ProjectResponse = {
      ...primary,
      carbonSequestrationEstimate: mergedEst,
      totalAreaHa: mergedArea,
    };

    const mergedSecondary: ProjectResponse = {
      ...secondary,
      status: ProjectStatusEnum.Inactive,
    };

    return { mergedPrimary, mergedSecondary };
  }

  async applyMerge(
    primary: ProjectResponse,
    secondary: ProjectResponse,
    mergedPrimary: ProjectResponse,
    mergedSecondary: ProjectResponse,
    _context: { actor: string; reason: string },
  ): Promise<void> {
    this.localStore.set(String(primary.id), mergedPrimary);
    this.localStore.set(String(secondary.id), mergedSecondary);
  }

  async applyReversal(
    primaryId: string,
    secondaryId: string,
    preMergePrimary: ProjectResponse,
    preMergeSecondary: ProjectResponse,
    _context: { actor: string; reason: string },
  ): Promise<void> {
    this.localStore.set(primaryId, preMergePrimary);
    this.localStore.set(secondaryId, preMergeSecondary);
  }

  computeStateDigest(entity: ProjectResponse): string {
    const state = {
      id: entity.id,
      name: entity.name,
      status: entity.status,
      country: entity.country,
      carbonSequestrationEstimate: entity.carbonSequestrationEstimate,
      totalAreaHa: entity.totalAreaHa,
      metadataIpfsHash: entity.metadataIpfsHash,
    };
    return computeCanonicalDigest(state);
  }
}
