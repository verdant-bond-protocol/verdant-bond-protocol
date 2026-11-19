import {
  BoundedBatchAuthorizationError,
  BoundedBatchProcessor,
  MAX_BOUNDED_BATCH_SIZE,
} from './bounded-batch-processor';

describe('BoundedBatchProcessor (#526)', () => {
  let processor: BoundedBatchProcessor;

  beforeEach(() => {
    processor = new BoundedBatchProcessor();
  });

  it('normal path: processes large dataset in bounded batches and clamps oversized batchSize', async () => {
    const dataset = Array.from({ length: 1200 }, (_, i) => i + 1);
    const observedBatchSizes: number[] = [];
    const processedItems: number[] = [];

    const result = await processor.process(
      async (cursor, limit) => dataset.slice(cursor, cursor + limit),
      async (batch) => {
        observedBatchSizes.push(batch.length);
        processedItems.push(...batch);
      },
      {
        actorRole: 'OPERATOR',
        batchSize: 5000, // Exceeds MAX_BOUNDED_BATCH_SIZE (500), must clamp
      },
    );

    expect(result.status).toBe('completed');
    expect(result.totalProcessed).toBe(1200);
    expect(result.succeeded).toBe(1200);
    expect(result.failed).toBe(0);
    expect(result.batchesExecuted).toBe(3);
    expect(observedBatchSizes).toEqual([MAX_BOUNDED_BATCH_SIZE, MAX_BOUNDED_BATCH_SIZE, 200]);
    expect(processedItems).toHaveLength(1200);
  });

  it('retry path: retries transient batch failures and resumes cleanly from nextCursor', async () => {
    const dataset = Array.from({ length: 10 }, (_, i) => i + 1);
    let batch1Calls = 0;

    const result = await processor.process(
      async (cursor, limit) => dataset.slice(cursor, cursor + limit),
      async (_batch, batchIndex) => {
        if (batchIndex === 1) {
          batch1Calls += 1;
          if (batch1Calls === 1) {
            throw new Error('Transient DB deadlock');
          }
        }
      },
      {
        actorRole: 'ADMIN',
        batchSize: 4,
        maxRetries: 2,
      },
    );

    expect(result.status).toBe('completed');
    expect(result.retriesUsed).toBe(1);
    expect(result.succeeded).toBe(10);
    expect(result.failed).toBe(0);
    expect(result.nextCursor).toBe(10);
  });

  it('failure & rollback path: invokes rollback hook and aborts when maxFailures reached', async () => {
    const dataset = Array.from({ length: 15 }, (_, i) => i + 1);
    const rolledBackBatches: number[] = [];

    const result = await processor.process(
      async (cursor, limit) => dataset.slice(cursor, cursor + limit),
      async () => {
        throw new Error('Permanent downstream outage');
      },
      {
        actorRole: 'ADMIN',
        batchSize: 5,
        maxRetries: 1,
        maxFailures: 2,
        onBatchFailureRollback: async (_batch, batchIndex) => {
          rolledBackBatches.push(batchIndex);
        },
      },
    );

    expect(result.status).toBe('aborted');
    expect(result.batchesExecuted).toBe(2);
    expect(result.failed).toBe(10);
    expect(result.nextCursor).toBe(10);
    expect(rolledBackBatches).toEqual([0, 1]);
  });

  it('authorization path: rejects non-privileged actors before reading any page', async () => {
    let fetchCalled = false;

    await expect(
      processor.process(
        async () => {
          fetchCalled = true;
          return [1];
        },
        async () => {},
        { actorRole: 'INVESTOR', batchSize: 10 },
      ),
    ).rejects.toThrow(BoundedBatchAuthorizationError);

    expect(fetchCalled).toBe(false);
  });
});
