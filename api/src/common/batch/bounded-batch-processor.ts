export const DEFAULT_BOUNDED_BATCH_SIZE = 50;
export const MAX_BOUNDED_BATCH_SIZE = 500;
export const MAX_ITEMS_PER_RUN = 50_000;
export const MAX_BATCH_RETRIES = 3;

export type BatchActorRole = 'ADMIN' | 'OPERATOR' | 'INVESTOR' | 'GUEST';

export interface BoundedBatchOptions<T> {
  /** Requested batch size; clamped to [1, MAX_BOUNDED_BATCH_SIZE]. */
  batchSize?: number;
  /** Maximum total items to process in a single invocation; clamped to MAX_ITEMS_PER_RUN. */
  maxItems?: number;
  /** Maximum consecutive/total batch failures before aborting (circuit breaker). */
  maxFailures?: number;
  /** Maximum retry attempts per failed batch. */
  maxRetries?: number;
  /** Cursor to resume from (index offset). */
  startCursor?: number;
  /** Actor role executing the batch run; must be ADMIN or OPERATOR. */
  actorRole: BatchActorRole;
  /** Optional rollback hook invoked if a batch fails permanently after retries. */
  onBatchFailureRollback?: (batch: T[], batchIndex: number, error: Error) => Promise<void> | void;
  /** Optional deterministic sleep hook (defaults to immediate yield). */
  sleep?: (ms: number) => Promise<void>;
}

export interface BoundedBatchResult {
  status: 'completed' | 'aborted';
  batchesExecuted: number;
  totalProcessed: number;
  succeeded: number;
  failed: number;
  retriesUsed: number;
  nextCursor: number;
  errors: Array<{ batchIndex: number; cursor: number; message: string }>;
}

export class BoundedBatchAuthorizationError extends Error {
  constructor(role: string) {
    super(`Unauthorized batch actor role "${role}": ADMIN or OPERATOR required.`);
    this.name = 'BoundedBatchAuthorizationError';
  }
}

export class BoundedBatchProcessor {
  /**
   * Process a large dataset in bounded chunks with cursor-based resumption,
   * retry-on-transient-failure, circuit breaking, and rollback hooks.
   */
  async process<T>(
    fetchPage: (cursor: number, limit: number) => Promise<T[]>,
    handleBatch: (batch: T[], batchIndex: number) => Promise<void>,
    options: BoundedBatchOptions<T>,
  ): Promise<BoundedBatchResult> {
    if (options.actorRole !== 'ADMIN' && options.actorRole !== 'OPERATOR') {
      throw new BoundedBatchAuthorizationError(options.actorRole);
    }

    const batchSize = Math.min(
      Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BOUNDED_BATCH_SIZE)),
      MAX_BOUNDED_BATCH_SIZE,
    );
    const maxItems = Math.min(
      Math.max(1, Math.floor(options.maxItems ?? MAX_ITEMS_PER_RUN)),
      MAX_ITEMS_PER_RUN,
    );
    const maxFailures = Math.max(1, Math.floor(options.maxFailures ?? 3));
    const maxRetries = Math.min(Math.max(0, Math.floor(options.maxRetries ?? 2)), MAX_BATCH_RETRIES);
    const sleep = options.sleep ?? (async () => Promise.resolve());

    let cursor = Math.max(0, Math.floor(options.startCursor ?? 0));
    let batchesExecuted = 0;
    let totalProcessed = 0;
    let succeeded = 0;
    let failed = 0;
    let retriesUsed = 0;
    const errors: BoundedBatchResult['errors'] = [];

    while (totalProcessed < maxItems) {
      const remainingBudget = maxItems - totalProcessed;
      const limit = Math.min(batchSize, remainingBudget);
      const page = await fetchPage(cursor, limit);

      if (!page || page.length === 0) {
        break;
      }

      const boundedPage = page.slice(0, limit);
      const batchIndex = batchesExecuted;
      let attempt = 0;
      let batchSucceeded = false;
      let lastError: Error = new Error('Unknown batch error');

      while (attempt <= maxRetries) {
        try {
          await handleBatch(boundedPage, batchIndex);
          batchSucceeded = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < maxRetries) {
            retriesUsed += 1;
            attempt += 1;
            await sleep(attempt * 10);
          } else {
            break;
          }
        }
      }

      batchesExecuted += 1;
      totalProcessed += boundedPage.length;
      cursor += boundedPage.length;

      if (batchSucceeded) {
        succeeded += boundedPage.length;
      } else {
        failed += boundedPage.length;
        errors.push({ batchIndex, cursor: cursor - boundedPage.length, message: lastError.message });
        if (options.onBatchFailureRollback) {
          await options.onBatchFailureRollback(boundedPage, batchIndex, lastError);
        }
        if (errors.length >= maxFailures) {
          return {
            status: 'aborted',
            batchesExecuted,
            totalProcessed,
            succeeded,
            failed,
            retriesUsed,
            nextCursor: cursor,
            errors,
          };
        }
      }

      if (boundedPage.length < limit) {
        break;
      }
    }

    return {
      status: 'completed',
      batchesExecuted,
      totalProcessed,
      succeeded,
      failed,
      retriesUsed,
      nextCursor: cursor,
      errors,
    };
  }
}
