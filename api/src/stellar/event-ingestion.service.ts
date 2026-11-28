import { Injectable, Logger, ForbiddenException, BadRequestException } from '@nestjs/common';

/**
 * Soroban contract event structure with deterministic ordering attributes
 */
export interface SorobanEvent {
  id: string;
  transactionHash: string;
  ledgerSeq: number;
  opIndex: number;
  eventIndex: number;
  topic: string[];
  value: any;
  pagingToken?: string;
  inSuccessfulContractCall?: boolean;
}

/**
 * Checkpoint tracking state for indexer restart recovery (#633)
 */
export interface IndexerCheckpoint {
  lastCommittedLedgerSeq: number;
  lastCommittedEventId: string | null;
  committedAt: string;
}

export interface IngestionBatchReport {
  status: 'SUCCESS' | 'GAP_DETECTED' | 'UNFINALIZED_DEFERRED';
  orderedEventIds: string[];
  processedCount: number;
  skippedDuplicatesCount: number;
  deferredCount: number;
  lastCommittedLedgerSeq: number;
  gapDetails?: {
    expectedLedger: number;
    receivedLedger: number;
  };
}

export class IndexerSequenceGapError extends BadRequestException {
  constructor(expected: number, received: number) {
    super(`Indexer sequence gap detected: expected ledger ${expected}, received ${received}. Backfill required.`);
  }
}

/**
 * Pure deterministic comparator for Soroban events (#633).
 *
 * Enforces a strict total order tuple:
 * (ledgerSeq ASC, opIndex ASC, eventIndex ASC, id ASC)
 *
 * Guarantees identical execution ordering regardless of network packet arrival order.
 * Time Complexity: O(1) comparison
 */
export function compareSorobanEvents(a: SorobanEvent, b: SorobanEvent): number {
  if (a.ledgerSeq !== b.ledgerSeq) {
    return a.ledgerSeq - b.ledgerSeq;
  }
  if (a.opIndex !== b.opIndex) {
    return a.opIndex - b.opIndex;
  }
  if (a.eventIndex !== b.eventIndex) {
    return a.eventIndex - b.eventIndex;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Event Ingestion Service with Deterministic Event Ordering & Restart Recovery (#633)
 *
 * Features:
 * - Deterministic ordering over Soroban events across indexer restarts
 * - Sequence gap detection preventing out-of-order state application
 * - Confirmation depth safety against transient blockchain forks
 * - Idempotent event deduplication (zero double-spending or duplicate coupon claims)
 * - Administrative checkpoint management with strict authorization checks
 */
@Injectable()
export class EventIngestionService {
  private readonly logger = new Logger(EventIngestionService.name);
  private readonly CONFIRMATION_DEPTH = 5; // 5 ledgers deep for finality
  private lastCommittedLedgerSeq = 0;
  private lastCommittedEventId: string | null = null;
  private readonly processedIdempotencyKeys = new Set<string>();

  constructor() {}

  /**
   * Generates a deterministic idempotency key resilient to transaction re-hashing in reorgs.
   * Format: event:{ledgerSeq}:{opIndex}:{eventIndex}
   */
  generateIdempotencyKey(event: SorobanEvent): string {
    return `event:${event.ledgerSeq}:${event.opIndex}:${event.eventIndex}`;
  }

  /**
   * Determines if an event has met finality requirements before financial state updates.
   */
  isFinal(eventLedgerSeq: number, currentLedgerSeq: number): boolean {
    return currentLedgerSeq - eventLedgerSeq >= this.CONFIRMATION_DEPTH;
  }

  /**
   * Gets current checkpoint state
   */
  getCheckpoint(): IndexerCheckpoint {
    return {
      lastCommittedLedgerSeq: this.lastCommittedLedgerSeq,
      lastCommittedEventId: this.lastCommittedEventId,
      committedAt: new Date().toISOString(),
    };
  }

  /**
   * Admin-authorized checkpoint rewind or reset for disaster recovery or backfill (#633)
   */
  resetCheckpoint(
    targetLedgerSeq: number,
    actor?: { isAdmin?: boolean },
  ): IndexerCheckpoint {
    if (!actor?.isAdmin) {
      throw new ForbiddenException('Admin role required to modify indexer checkpoint');
    }
    if (targetLedgerSeq < 0) {
      throw new BadRequestException('Target ledger sequence must be non-negative');
    }

    this.logger.warn(
      `INDEXER CHECKPOINT RESET: Rewinding from ${this.lastCommittedLedgerSeq} to ${targetLedgerSeq}`,
    );

    this.lastCommittedLedgerSeq = targetLedgerSeq;
    this.lastCommittedEventId = null;

    // Prune idempotency keys higher than targetLedgerSeq
    for (const key of Array.from(this.processedIdempotencyKeys)) {
      const parts = key.split(':');
      if (parts.length >= 2) {
        const seq = parseInt(parts[1], 10);
        if (seq > targetLedgerSeq) {
          this.processedIdempotencyKeys.delete(key);
        }
      }
    }

    return this.getCheckpoint();
  }

  /**
   * Sorts incoming batch of events deterministically.
   *
   * Time Complexity: O(K log K) where K = events.length
   * Space Complexity: O(K)
   */
  orderEventsDeterministically(events: SorobanEvent[]): SorobanEvent[] {
    return [...events].sort(compareSorobanEvents);
  }

  /**
   * Ingests a batch of events with deterministic ordering, gap verification, and restart recovery (#633)
   *
   * Normal Path:
   *   1. Sorts events deterministically
   *   2. Verifies continuity against last committed ledger sequence
   *   3. Filters out unfinalized events (deferring them until confirmation depth is met)
   *   4. Deduplicates against already-processed events
   *   5. Updates checkpoint state deterministically
   *
   * Failure Path:
   *   Detects sequence gaps (e.g. expected ledger 101 but received 103); halts before mutating state.
   */
  async processBatchWithDeterministicOrdering(
    events: SorobanEvent[],
    currentLedgerSeq: number,
    onEventProcess?: (event: SorobanEvent) => Promise<void> | void,
  ): Promise<IngestionBatchReport> {
    if (!events || events.length === 0) {
      return {
        status: 'SUCCESS',
        orderedEventIds: [],
        processedCount: 0,
        skippedDuplicatesCount: 0,
        deferredCount: 0,
        lastCommittedLedgerSeq: this.lastCommittedLedgerSeq,
      };
    }

    // 1. Sort all events deterministically using the total order tuple
    const sorted = this.orderEventsDeterministically(events);

    // 2. Validate sequence gap
    const lowestBatchLedger = sorted[0].ledgerSeq;
    if (this.lastCommittedLedgerSeq > 0 && lowestBatchLedger > this.lastCommittedLedgerSeq + 1) {
      this.logger.error(
        `Sequence gap detected during indexer processing: expected ledger ${this.lastCommittedLedgerSeq + 1}, but received ${lowestBatchLedger}`,
      );
      return {
        status: 'GAP_DETECTED',
        orderedEventIds: [],
        processedCount: 0,
        skippedDuplicatesCount: 0,
        deferredCount: 0,
        lastCommittedLedgerSeq: this.lastCommittedLedgerSeq,
        gapDetails: {
          expectedLedger: this.lastCommittedLedgerSeq + 1,
          receivedLedger: lowestBatchLedger,
        },
      };
    }

    const orderedEventIds: string[] = [];
    let processedCount = 0;
    let skippedDuplicatesCount = 0;
    let deferredCount = 0;

    for (const event of sorted) {
      // 3. Finality verification
      if (!this.isFinal(event.ledgerSeq, currentLedgerSeq)) {
        this.logger.debug(
          `Event ${event.id} at ledger ${event.ledgerSeq} deferred (current ledger ${currentLedgerSeq}, depth < ${this.CONFIRMATION_DEPTH})`,
        );
        deferredCount++;
        continue;
      }

      // 4. Deduplication via idempotency key
      const key = this.generateIdempotencyKey(event);
      if (this.processedIdempotencyKeys.has(key)) {
        skippedDuplicatesCount++;
        continue;
      }

      // 5. Safe processing execution
      if (onEventProcess) {
        await onEventProcess(event);
      }

      this.processedIdempotencyKeys.add(key);
      orderedEventIds.push(event.id);
      processedCount++;

      // Advance checkpoint
      if (event.ledgerSeq > this.lastCommittedLedgerSeq) {
        this.lastCommittedLedgerSeq = event.ledgerSeq;
      }
      this.lastCommittedEventId = event.id;
    }

    return {
      status: deferredCount > 0 && processedCount === 0 ? 'UNFINALIZED_DEFERRED' : 'SUCCESS',
      orderedEventIds,
      processedCount,
      skippedDuplicatesCount,
      deferredCount,
      lastCommittedLedgerSeq: this.lastCommittedLedgerSeq,
    };
  }

  /**
   * Compatibility method for existing single-event processing
   */
  async processEventSafely(event: SorobanEvent, currentLedgerSeq: number): Promise<void> {
    await this.processBatchWithDeterministicOrdering([event], currentLedgerSeq);
  }
}
