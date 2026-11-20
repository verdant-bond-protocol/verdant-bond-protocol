import { Injectable, Logger } from '@nestjs/common';
import { DeduplicationAdapter } from './deduplication-adapter.interface';
import {
  EntityType,
  FieldDiff,
  FieldResolutionStrategy,
  RuleEvaluation,
} from '../deduplication.types';
import { KycRecord, KycStatus } from '../../common/interfaces/authenticated-request.interface';
import { KycService } from '../../auth/kyc.service';
import { KycStoreService } from '../../common/services/kyc-store.service';
import {
  canonicalNormalize,
  computeCanonicalDigest,
  jaccardTrigramSimilarity,
  levenshteinSimilarity,
} from '../similarity-scoring';

const STATUS_RANKS: Record<KycStatus, number> = {
  [KycStatus.ACCREDITED]: 5,
  [KycStatus.VERIFIED]: 4,
  [KycStatus.PENDING]: 3,
  [KycStatus.EXPIRED]: 2,
  [KycStatus.REJECTED]: 1,
  [KycStatus.NONE]: 0,
};

@Injectable()
export class KycDeduplicationAdapter implements DeduplicationAdapter<KycRecord> {
  readonly entityType = EntityType.KYC_RECORD;
  private readonly logger = new Logger(KycDeduplicationAdapter.name);

  constructor(
    private readonly kycService: KycService,
    private readonly kycStore: KycStoreService,
  ) {}

  async fetchEntities(): Promise<KycRecord[]> {
    const list = await this.kycStore.list();
    // Exclude records that are already soft-deleted/none or merged
    return list.filter((r) => r.status !== KycStatus.NONE);
  }

  async getEntity(address: string): Promise<KycRecord | null> {
    return this.kycStore.get(address);
  }

  idOf(record: KycRecord): string {
    return record.address;
  }

  evaluateCandidate(a: KycRecord, b: KycRecord): { confidence: number; evaluations: RuleEvaluation[] } {
    const evaluations: RuleEvaluation[] = [];

    // Rule 1: Exact provider reference match across different wallet addresses
    const hasProviderRef = Boolean(a.providerReference && b.providerReference);
    const exactProviderRef =
      hasProviderRef &&
      canonicalNormalize(a.providerReference) === canonicalNormalize(b.providerReference);
    const score1 = exactProviderRef ? 1.0 : 0.0;
    evaluations.push({
      ruleId: 'EXACT_PROVIDER_REFERENCE',
      ruleName: 'KYC Provider Reference Match',
      score: score1,
      weight: 0.5,
      threshold: 1.0,
      passed: exactProviderRef,
      details: exactProviderRef
        ? `Matching providerReference: ${a.providerReference}`
        : 'Provider references do not match or are absent',
    });

    // Rule 2: Similarity in reason / identity metadata
    const normReasonA = canonicalNormalize(a.reason || '');
    const normReasonB = canonicalNormalize(b.reason || '');
    let score2 = 0.0;
    if (normReasonA && normReasonB) {
      score2 = Math.max(
        jaccardTrigramSimilarity(normReasonA, normReasonB),
        levenshteinSimilarity(normReasonA, normReasonB),
      );
    }
    evaluations.push({
      ruleId: 'IDENTITY_METADATA_SIMILARITY',
      ruleName: 'Identity Metadata & Audit Reason Similarity',
      score: score2,
      weight: 0.3,
      threshold: 0.75,
      passed: score2 >= 0.75,
      details: `Similarity score: ${score2}`,
    });

    // Rule 3: Registration window and actor proximity
    let score3 = 0.0;
    if (a.actor && b.actor && a.actor === b.actor) {
      score3 += 0.5;
    }
    const timeDeltaMs = Math.abs(a.createdAt - b.createdAt);
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    if (timeDeltaMs <= ONE_DAY_MS) {
      score3 += 0.5 * (1 - timeDeltaMs / ONE_DAY_MS);
    }
    score3 = Number(score3.toFixed(4));
    evaluations.push({
      ruleId: 'OPERATOR_AND_TIME_PROXIMITY',
      ruleName: 'Operator Actor and Registration Time Proximity',
      score: score3,
      weight: 0.2,
      threshold: 0.6,
      passed: score3 >= 0.6,
      details: `Actor match: ${a.actor === b.actor}, timeDelta: ${Math.round(timeDeltaMs / 1000)}s`,
    });

    // Total weighted confidence
    const totalWeight = evaluations.reduce((sum, e) => sum + e.weight, 0);
    const weightedSum = evaluations.reduce((sum, e) => sum + e.score * e.weight, 0);
    const confidence = Number((weightedSum / totalWeight).toFixed(4));

    return { confidence, evaluations };
  }

  computeDiffs(primary: KycRecord, secondary: KycRecord): FieldDiff[] {
    const fields: (keyof KycRecord)[] = [
      'address',
      'status',
      'providerReference',
      'expiresAt',
      'source',
      'actor',
      'reason',
    ];
    return fields.map((f) => ({
      fieldName: f,
      primaryValue: primary[f] ?? null,
      secondaryValue: secondary[f] ?? null,
      identical: primary[f] === secondary[f],
    }));
  }

  computeMergedState(
    primary: KycRecord,
    secondary: KycRecord,
    strategies: Record<string, { strategy: FieldResolutionStrategy; manualValue?: any }> = {},
  ): { mergedPrimary: KycRecord; mergedSecondary: KycRecord } {
    const now = Date.now();

    // 1. Resolve Status
    let mergedStatus = primary.status;
    const statusStrategy = strategies.status?.strategy ?? FieldResolutionStrategy.PRIMARY_WINS;
    if (statusStrategy === FieldResolutionStrategy.MANUAL && strategies.status?.manualValue) {
      mergedStatus = strategies.status.manualValue;
    } else if (statusStrategy === FieldResolutionStrategy.SECONDARY_WINS) {
      mergedStatus = secondary.status;
    } else {
      // Default: Highest rank wins
      const rankPrimary = STATUS_RANKS[primary.status] ?? 0;
      const rankSecondary = STATUS_RANKS[secondary.status] ?? 0;
      mergedStatus = rankSecondary > rankPrimary ? secondary.status : primary.status;
    }

    // 2. Resolve Expiration
    let mergedExpiresAt = primary.expiresAt;
    const expiresStrategy = strategies.expiresAt?.strategy ?? FieldResolutionStrategy.LATEST;
    if (expiresStrategy === FieldResolutionStrategy.MANUAL) {
      mergedExpiresAt = strategies.expiresAt.manualValue ?? null;
    } else if (expiresStrategy === FieldResolutionStrategy.SECONDARY_WINS) {
      mergedExpiresAt = secondary.expiresAt;
    } else if (expiresStrategy === FieldResolutionStrategy.PRIMARY_WINS) {
      mergedExpiresAt = primary.expiresAt;
    } else {
      // Default: latest timestamp
      const expP = primary.expiresAt ?? 0;
      const expS = secondary.expiresAt ?? 0;
      mergedExpiresAt = Math.max(expP, expS) || null;
    }

    // 3. Resolve Provider Reference
    let mergedProviderRef = primary.providerReference;
    const refStrategy = strategies.providerReference?.strategy ?? FieldResolutionStrategy.PRIMARY_WINS;
    if (refStrategy === FieldResolutionStrategy.MANUAL) {
      mergedProviderRef = strategies.providerReference.manualValue ?? null;
    } else if (refStrategy === FieldResolutionStrategy.SECONDARY_WINS) {
      mergedProviderRef = secondary.providerReference;
    } else if (!mergedProviderRef && secondary.providerReference) {
      mergedProviderRef = secondary.providerReference;
    }

    const mergedPrimary: KycRecord = {
      ...primary,
      status: mergedStatus,
      expiresAt: mergedExpiresAt,
      providerReference: mergedProviderRef,
      reason: `Merged with duplicate account ${secondary.address}. ${primary.reason || ''}`.trim(),
      updatedAt: now,
    };

    const mergedSecondary: KycRecord = {
      ...secondary,
      status: KycStatus.NONE,
      reason: `Merged into primary account ${primary.address}`,
      updatedAt: now,
    };

    return { mergedPrimary, mergedSecondary };
  }

  async applyMerge(
    primary: KycRecord,
    secondary: KycRecord,
    mergedPrimary: KycRecord,
    mergedSecondary: KycRecord,
    context: { actor: string; reason: string },
  ): Promise<void> {
    // 1. Update primary account
    await this.kycService.transitionStatus(primary.address, mergedPrimary.status, {
      source: 'admin',
      actor: context.actor,
      reason: `Merge executed: primary ${primary.address} absorbed duplicate ${secondary.address} — ${context.reason}`,
      providerReference: mergedPrimary.providerReference,
      expiresAt: mergedPrimary.expiresAt,
    });

    // 2. Mark secondary account as merged (transition to NONE with merge pointer)
    await this.kycService.transitionStatus(secondary.address, KycStatus.NONE, {
      source: 'admin',
      actor: context.actor,
      reason: `Merge executed: secondary ${secondary.address} merged into primary ${primary.address} — ${context.reason}`,
      providerReference: secondary.providerReference,
      expiresAt: null,
    });
  }

  async applyReversal(
    primaryId: string,
    secondaryId: string,
    preMergePrimary: KycRecord,
    preMergeSecondary: KycRecord,
    context: { actor: string; reason: string },
  ): Promise<void> {
    // 1. Restore secondary record to its pre-merge state
    await this.kycService.transitionStatus(secondaryId, preMergeSecondary.status, {
      source: 'admin',
      actor: context.actor,
      reason: `Merge rollback: restored secondary ${secondaryId} to pre-merge state — ${context.reason}`,
      providerReference: preMergeSecondary.providerReference,
      expiresAt: preMergeSecondary.expiresAt,
    });

    // 2. Restore primary record to its pre-merge state
    await this.kycService.transitionStatus(primaryId, preMergePrimary.status, {
      source: 'admin',
      actor: context.actor,
      reason: `Merge rollback: restored primary ${primaryId} to pre-merge state — ${context.reason}`,
      providerReference: preMergePrimary.providerReference,
      expiresAt: preMergePrimary.expiresAt,
    });
  }

  computeStateDigest(record: KycRecord): string {
    const state = {
      address: record.address,
      status: record.status,
      providerReference: record.providerReference ?? null,
      expiresAt: record.expiresAt ?? null,
    };
    return computeCanonicalDigest(state);
  }
}
