import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import {
  CandidateDuplicate,
  CandidateFilter,
  CandidateReview,
  CandidateStatus,
  DeduplicationScanOptions,
  DeduplicationScanResult,
  EntityType,
  FieldResolutionStrategy,
  MergeJournalEntry,
  MergeStatus,
} from './deduplication.types';
import { DeduplicationAdapter } from './adapters/deduplication-adapter.interface';
import { KycDeduplicationAdapter } from './adapters/kyc-deduplication.adapter';
import { ProjectDeduplicationAdapter } from './adapters/project-deduplication.adapter';
import { AuditService } from '../audit/audit.service';
import {
  compareIds,
  computeCanonicalDigest,
  computeScanFingerprintV2,
  deterministicCandidateId,
  stableJsonStringify,
  stableSortCandidates,
} from './similarity-scoring';

@Injectable()
export class DeduplicationService {
  private readonly logger = new Logger(DeduplicationService.name);

  // In-memory durable stores for candidates and merge journals
  private readonly candidates = new Map<string, CandidateDuplicate>();
  private readonly mergeJournals = new Map<string, MergeJournalEntry>();
  private readonly adapters = new Map<EntityType, DeduplicationAdapter<any>>();

  // Clock provider for deterministic testing
  now: () => Date = () => new Date();

  constructor(
    private readonly kycAdapter: KycDeduplicationAdapter,
    private readonly projectAdapter: ProjectDeduplicationAdapter,
    @Optional() private readonly auditService?: AuditService,
  ) {
    this.registerAdapter(this.kycAdapter);
    this.registerAdapter(this.projectAdapter);
  }

  registerAdapter(adapter: DeduplicationAdapter<any>): void {
    this.adapters.set(adapter.entityType, adapter);
  }

  getAdapter(entityType: EntityType): DeduplicationAdapter<any> {
    const adapter = this.adapters.get(entityType);
    if (!adapter) {
      throw new BadRequestException(`No deduplication adapter registered for entity type: ${entityType}`);
    }
    return adapter;
  }

  /**
   * Deterministically scans an entity collection for candidate duplicates.
   * Produces reproducible candidate IDs, similarity scores, and tie-breaking order.
   */
  async scan(options: DeduplicationScanOptions): Promise<DeduplicationScanResult> {
    const adapter = this.getAdapter(options.entityType);
    const entities = await adapter.fetchEntities();
    const minConfidence = options.minConfidence ?? 0.65;
    const scannedAt = this.now().toISOString();

    const discovered: CandidateDuplicate[] = [];

    // Compare all pairs (i, j) deterministically
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const entityA = entities[i];
        const entityB = entities[j];
        const idA = adapter.idOf(entityA);
        const idB = adapter.idOf(entityB);

        if (idA === idB) continue;

        const { confidence, evaluations } = adapter.evaluateCandidate(entityA, entityB);

        if (confidence >= minConfidence) {
          const candidateId = deterministicCandidateId(options.entityType, idA, idB);

          // Deterministic primary selection:
          // Lower lexicographical ID becomes primary by default for stability
          const [primary, secondary] = compareIds(idA, idB) <= 0 ? [entityA, entityB] : [entityB, entityA];
          const primaryId = adapter.idOf(primary);
          const secondaryId = adapter.idOf(secondary);

          const primaryDigest = adapter.computeStateDigest(primary);
          const secondaryDigest = adapter.computeStateDigest(secondary);
          const diffs = adapter.computeDiffs(primary, secondary);

          // Preserve existing review state if candidate was previously reviewed
          const existing = this.candidates.get(candidateId);
          let status = CandidateStatus.PENDING_REVIEW;
          let review = existing?.review;
          const mergeId = existing?.mergeId;

          if (existing) {
            // If states haven't drifted, keep existing review decision
            if (
              existing.primaryDigest === primaryDigest &&
              existing.secondaryDigest === secondaryDigest
            ) {
              status = existing.status;
            } else if (existing.status !== CandidateStatus.MERGED) {
              // Reset to pending_review if state drifted prior to merge
              status = CandidateStatus.PENDING_REVIEW;
              review = undefined;
            }
          }

          const candidate: CandidateDuplicate = {
            id: candidateId,
            entityType: options.entityType,
            primaryId,
            secondaryId,
            confidenceScore: confidence,
            evaluations,
            status,
            detectedAt: existing?.detectedAt ?? scannedAt,
            primarySnapshot: primary,
            secondarySnapshot: secondary,
            primaryDigest,
            secondaryDigest,
            diffs,
            review,
            mergeId,
          };

          this.candidates.set(candidateId, candidate);
          discovered.push(candidate);
        }
      }
    }

    const sorted = stableSortCandidates(discovered);
    const resultCandidates = options.limit ? sorted.slice(0, options.limit) : sorted;

    const scanFingerprint = createHash('sha256')
      .update(
        stableJsonStringify({
          entityType: options.entityType,
          totalScanned: entities.length,
          candidatesFound: discovered.length,
          candidateIds: resultCandidates.map((c) => c.id),
        }),
      )
      .digest('hex');

    // Additive content-bearing fingerprint: keeps the legacy field intact while
    // making score / review-state drift observable to callers and audit logs.
    const scanFingerprintV2 = computeScanFingerprintV2({
      entityType: options.entityType,
      minConfidence,
      totalScanned: entities.length,
      candidates: resultCandidates.map((c) => ({
        id: c.id,
        primaryId: c.primaryId,
        secondaryId: c.secondaryId,
        confidenceScore: c.confidenceScore,
        primaryDigest: c.primaryDigest,
        secondaryDigest: c.secondaryDigest,
        status: c.status,
      })),
    });

    if (this.auditService && discovered.length > 0) {
      await this.auditService.record({
        entityType: 'deduplication',
        entityId: `scan:${options.entityType}:${scanFingerprint.slice(0, 16)}`,
        action: 'scan_completed',
        actor: 'system',
        reason: `Deduplication scan found ${discovered.length} candidate duplicates across ${entities.length} records`,
        before: null,
        after: {
          entityType: options.entityType,
          scannedCount: entities.length,
          candidatesFound: discovered.length,
          scanFingerprint,
          scanFingerprintV2,
        },
      });
    }

    return {
      entityType: options.entityType,
      scannedCount: entities.length,
      candidatesFound: discovered.length,
      candidates: resultCandidates,
      scanFingerprint,
      scanFingerprintV2,
      scannedAt,
    };
  }

  /**
   * Lists candidate duplicates with reproducible filtering, sorting, and pagination.
   */
  async listCandidates(filter: CandidateFilter = {}): Promise<{
    data: CandidateDuplicate[];
    total: number;
    offset: number;
    limit: number;
  }> {
    let list = Array.from(this.candidates.values());

    if (filter.entityType) {
      list = list.filter((c) => c.entityType === filter.entityType);
    }
    if (filter.status) {
      list = list.filter((c) => c.status === filter.status);
    }
    if (filter.minConfidence !== undefined) {
      list = list.filter((c) => c.confidenceScore >= filter.minConfidence!);
    }

    const sorted = stableSortCandidates(list);
    const total = sorted.length;
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    const data = sorted.slice(offset, offset + limit);

    return { data, total, offset, limit };
  }

  /**
   * Retrieves a single candidate duplicate by ID.
   */
  async getCandidate(id: string): Promise<CandidateDuplicate> {
    const candidate = this.candidates.get(id);
    if (!candidate) {
      throw new NotFoundException(`Candidate duplicate ${id} not found`);
    }
    return candidate;
  }

  /**
   * Human review workflow: approve, reject, or dismiss a candidate duplicate.
   */
  async reviewCandidate(
    candidateId: string,
    reviewDto: {
      reviewer: string;
      decision: 'approved' | 'rejected' | 'dismissed';
      reason: string;
      fieldStrategies?: Record<string, { strategy: FieldResolutionStrategy; manualValue?: any }>;
    },
  ): Promise<CandidateDuplicate> {
    const candidate = await this.getCandidate(candidateId);

    if (candidate.status === CandidateStatus.MERGED) {
      throw new ConflictException(`Candidate ${candidateId} has already been merged; review is immutable`);
    }

    const now = this.now().toISOString();
    const previousStatus = candidate.status;

    let targetStatus: CandidateStatus;
    if (reviewDto.decision === 'approved') {
      targetStatus = CandidateStatus.APPROVED;
    } else if (reviewDto.decision === 'rejected') {
      targetStatus = CandidateStatus.REJECTED;
    } else {
      targetStatus = CandidateStatus.DISMISSED;
    }

    const review: CandidateReview = {
      reviewer: reviewDto.reviewer,
      decision: reviewDto.decision,
      reason: reviewDto.reason,
      fieldStrategies: reviewDto.fieldStrategies,
      reviewedAt: now,
    };

    candidate.status = targetStatus;
    candidate.review = review;
    this.candidates.set(candidateId, candidate);

    if (this.auditService) {
      await this.auditService.record({
        entityType: 'deduplication',
        entityId: candidateId,
        action: 'candidate_reviewed',
        actor: reviewDto.reviewer,
        reason: reviewDto.reason,
        before: { status: previousStatus },
        after: { status: targetStatus, decision: reviewDto.decision, review },
      });
    }

    return candidate;
  }

  /**
   * Executes an approved merge between primary and secondary records.
   * Atomically applies changes, stores an immutable MergeJournalEntry, and emits audit records.
   */
  async executeMerge(
    candidateId: string,
    actor: string,
    reason?: string,
  ): Promise<MergeJournalEntry> {
    const candidate = await this.getCandidate(candidateId);

    if (candidate.status !== CandidateStatus.APPROVED) {
      throw new BadRequestException(
        `Candidate ${candidateId} cannot be merged in status '${candidate.status}'. Candidate must be 'approved' first.`,
      );
    }

    if (candidate.primaryId === candidate.secondaryId) {
      throw new BadRequestException(`Self-merge invariant violation: primary and secondary IDs are identical (${candidate.primaryId})`);
    }

    // Check for transitive merge conflict:
    // Secondary must not already have been merged into another entity
    for (const journal of this.mergeJournals.values()) {
      if (journal.status === MergeStatus.MERGED) {
        if (journal.secondaryId === candidate.secondaryId) {
          throw new ConflictException(
            `Transitive conflict: secondary entity ${candidate.secondaryId} was already merged in merge ${journal.id}`,
          );
        }
        if (journal.secondaryId === candidate.primaryId) {
          throw new ConflictException(
            `Transitive conflict: primary entity ${candidate.primaryId} was already merged into ${journal.primaryId} in merge ${journal.id}`,
          );
        }
      }
    }

    const adapter = this.getAdapter(candidate.entityType);

    // Fetch fresh live entities to detect state drift
    const freshPrimary = await adapter.getEntity(candidate.primaryId);
    const freshSecondary = await adapter.getEntity(candidate.secondaryId);

    if (!freshPrimary || !freshSecondary) {
      throw new NotFoundException(
        `Target entities no longer exist (primary: ${Boolean(freshPrimary)}, secondary: ${Boolean(freshSecondary)})`,
      );
    }

    const livePrimaryDigest = adapter.computeStateDigest(freshPrimary);
    const liveSecondaryDigest = adapter.computeStateDigest(freshSecondary);

    if (
      livePrimaryDigest !== candidate.primaryDigest ||
      liveSecondaryDigest !== candidate.secondaryDigest
    ) {
      throw new ConflictException(
        'STATE_DRIFT: One or both candidate entities changed since review. Re-run scan to review updated states.',
      );
    }

    // Compute merged states
    const fieldStrategies = candidate.review?.fieldStrategies ?? {};
    const { mergedPrimary, mergedSecondary } = adapter.computeMergedState(
      freshPrimary,
      freshSecondary,
      fieldStrategies,
    );

    const mergeReason = reason || candidate.review?.reason || 'Approved duplicate merge';

    // Apply merge through adapter
    await adapter.applyMerge(freshPrimary, freshSecondary, mergedPrimary, mergedSecondary, {
      actor,
      reason: mergeReason,
    });

    const mergeId = createHash('sha256')
      .update(`merge:${candidateId}:${this.now().getTime()}:${randomUUID()}`)
      .digest('hex');

    const executedAt = this.now().toISOString();

    const appliedStrategies: Record<string, FieldResolutionStrategy> = {};
    for (const [k, v] of Object.entries(fieldStrategies)) {
      appliedStrategies[k] = v.strategy;
    }

    const journalEntry: MergeJournalEntry = {
      id: mergeId,
      candidateId,
      entityType: candidate.entityType,
      primaryId: candidate.primaryId,
      secondaryId: candidate.secondaryId,
      preMergePrimary: freshPrimary,
      preMergeSecondary: freshSecondary,
      postMergePrimary: mergedPrimary,
      postMergeSecondary: mergedSecondary,
      appliedStrategies,
      executedBy: actor,
      executedAt,
      status: MergeStatus.MERGED,
      stateDigest: computeCanonicalDigest({
        primary: mergedPrimary,
        secondary: mergedSecondary,
      }),
    };

    this.mergeJournals.set(mergeId, journalEntry);

    // Update candidate
    candidate.status = CandidateStatus.MERGED;
    candidate.mergeId = mergeId;
    this.candidates.set(candidateId, candidate);

    if (this.auditService) {
      await this.auditService.record({
        entityType: 'deduplication',
        entityId: mergeId,
        action: 'merge_executed',
        actor,
        reason: mergeReason,
        before: {
          primary: freshPrimary,
          secondary: freshSecondary,
        },
        after: {
          primary: mergedPrimary,
          secondary: mergedSecondary,
        },
      });
    }

    return journalEntry;
  }

  /**
   * Reverses / rolls back a previously executed merge.
   * Restores both entities to their exact pre-merge snapshots and audits the reversal.
   */
  async reverseMerge(
    mergeId: string,
    actor: string,
    reason: string,
  ): Promise<MergeJournalEntry> {
    const journal = this.mergeJournals.get(mergeId);
    if (!journal) {
      throw new NotFoundException(`Merge journal entry ${mergeId} not found`);
    }

    if (journal.status === MergeStatus.REVERSED) {
      throw new ConflictException(`Merge ${mergeId} has already been reversed`);
    }

    // Verify transitive dependencies:
    // If primary was subsequently involved in another merge, reject rollback until later merges are reversed
    for (const other of this.mergeJournals.values()) {
      if (
        other.id !== mergeId &&
        other.status === MergeStatus.MERGED &&
        Date.parse(other.executedAt) > Date.parse(journal.executedAt) &&
        (other.primaryId === journal.primaryId || other.secondaryId === journal.primaryId)
      ) {
        throw new ConflictException(
          `Cannot reverse merge ${mergeId}: entity ${journal.primaryId} was involved in subsequent active merge ${other.id}. Reverse subsequent merges first.`,
        );
      }
    }

    const adapter = this.getAdapter(journal.entityType);

    // Apply reversal through adapter
    await adapter.applyReversal(
      journal.primaryId,
      journal.secondaryId,
      journal.preMergePrimary,
      journal.preMergeSecondary,
      { actor, reason },
    );

    const reversedAt = this.now().toISOString();
    journal.status = MergeStatus.REVERSED;
    journal.reversedBy = actor;
    journal.reversedAt = reversedAt;
    journal.reversalReason = reason;
    this.mergeJournals.set(mergeId, journal);

    // Update candidate status to reversed
    const candidate = this.candidates.get(journal.candidateId);
    if (candidate) {
      candidate.status = CandidateStatus.REVERSED;
      this.candidates.set(candidate.id, candidate);
    }

    if (this.auditService) {
      await this.auditService.record({
        entityType: 'deduplication',
        entityId: mergeId,
        action: 'merge_reversed',
        actor,
        reason,
        before: {
          primary: journal.postMergePrimary,
          secondary: journal.postMergeSecondary,
        },
        after: {
          primary: journal.preMergePrimary,
          secondary: journal.preMergeSecondary,
        },
      });
    }

    return journalEntryClone(journal);
  }

  /**
   * Retrieves a merge journal entry by ID.
   */
  async getMerge(mergeId: string): Promise<MergeJournalEntry> {
    const journal = this.mergeJournals.get(mergeId);
    if (!journal) {
      throw new NotFoundException(`Merge journal entry ${mergeId} not found`);
    }
    return journalEntryClone(journal);
  }

  /**
   * Retrieves all merge journal entries.
   */
  async listMerges(): Promise<MergeJournalEntry[]> {
    return Array.from(this.mergeJournals.values()).map(journalEntryClone);
  }
}

function journalEntryClone(entry: MergeJournalEntry): MergeJournalEntry {
  return JSON.parse(JSON.stringify(entry));
}
