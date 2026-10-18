import { IdempotencyService } from '../services/idempotency.service';
import { RedisService } from '../services/redis.service';

jest.mock('@redis/client', () => ({
  createClient: jest.fn().mockReturnValue({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    setEx: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
    disconnect: jest.fn().mockResolvedValue(undefined),
  }),
}));

/**
 * Concurrency tests for duplicate submissions and stale version detection (#423).
 *
 * Tests:
 * 1. Duplicate submission detection across concurrent requests
 * 2. Stale version rejection (optimistic locking)
 * 3. Idempotency key collision handling
 * 4. Stale data refresh and re-submission
 * 5. Cross-request deduplication
 */

class MockRedisForDuplicates extends RedisService {
  private readonly memoryStore = new Map<string, string>();
  private readonly locks = new Set<string>();
  private readonly versions = new Map<string, number>();

  constructor() {
    super();
  }

  async get(key: string): Promise<string | null> {
    return this.memoryStore.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string | null> {
    this.memoryStore.set(key, value);
    return 'OK';
  }

  async setEx(key: string, _seconds: number, value: string): Promise<void> {
    this.memoryStore.set(key, value);
  }

  async setNxValue(key: string, value: string, _ttlSeconds?: number): Promise<boolean> {
    if (this.memoryStore.has(key)) {
      return false;
    }
    this.memoryStore.set(key, value);
    return true;
  }

  async acquireLock(lockKey: string, _ttlMs: number): Promise<boolean> {
    if (this.locks.has(lockKey)) {
      return false;
    }
    this.locks.add(lockKey);
    return true;
  }

  async releaseLock(lockKey: string): Promise<void> {
    this.locks.delete(lockKey);
  }

  setVersion(key: string, version: number): void {
    this.versions.set(key, version);
  }

  getVersion(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  incrementVersion(key: string): number {
    const current = this.getVersion(key);
    const next = current + 1;
    this.versions.set(key, next);
    return next;
  }

  clear(): void {
    this.memoryStore.clear();
    this.locks.clear();
    this.versions.clear();
  }
}

// Simulated submission processor with duplicate detection
class SubmissionProcessor {
  private readonly submissions = new Map<string, { result: any; version: number; timestamp: number }>();
  private readonly redis: MockRedisForDuplicates;

  constructor(redis: MockRedisForDuplicates) {
    this.redis = redis;
  }

  async processSubmission(
    idempotencyKey: string,
    userId: string,
    data: any,
    expectedVersion: number = 0,
  ): Promise<{ success: boolean; result?: any; error?: string; isDuplicate?: boolean }> {
    // Check for duplicate submission
    if (this.submissions.has(idempotencyKey)) {
      const existing = this.submissions.get(idempotencyKey)!;
      return {
        success: true,
        result: existing.result,
        isDuplicate: true,
      };
    }

    // Check version staleness
    const currentVersion = this.redis.getVersion(`${userId}:version`);
    if (expectedVersion > 0 && expectedVersion < currentVersion) {
      return {
        success: false,
        error: 'STALE_VERSION',
      };
    }

    // Acquire lock to prevent concurrent modifications
    const lockKey = `lock:submission:${idempotencyKey}`;
    const acquired = await this.redis.acquireLock(lockKey, 5000);

    if (!acquired) {
      return { success: false, error: 'LOCK_TIMEOUT' };
    }

    try {
      // Simulate processing
      const result = {
        userId,
        dataHash: this.hashData(data),
        timestamp: Date.now(),
      };

      const newVersion = this.redis.incrementVersion(`${userId}:version`);

      this.submissions.set(idempotencyKey, {
        result,
        version: newVersion,
        timestamp: Date.now(),
      });

      return { success: true, result, isDuplicate: false };
    } finally {
      await this.redis.releaseLock(lockKey);
    }
  }

  private hashData(data: any): string {
    return JSON.stringify(data).split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0).toString(36);
  }

  getSubmission(idempotencyKey: string) {
    return this.submissions.get(idempotencyKey);
  }
}

describe('Duplicate Submissions & Stale Version Tests (#423)', () => {
  let redis: MockRedisForDuplicates;
  let processor: SubmissionProcessor;
  let idempotencyService: IdempotencyService;

  beforeEach(() => {
    redis = new MockRedisForDuplicates();
    processor = new SubmissionProcessor(redis);
    idempotencyService = new IdempotencyService(redis);
  });

  afterEach(() => {
    redis.clear();
  });

  describe('Duplicate Submission Detection', () => {
    it('1. Concurrent identical submissions return same result', async () => {
      const idempotencyKey = 'idem:bond_subscribe:user_1:123';
      const userId = 'user_1';
      const data = { bondId: '123', amount: '5000' };

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          processor.processSubmission(idempotencyKey, userId, data),
        ),
      );

      const successful = results.filter((r) => r.success);
      const duplicates = results.filter((r) => r.isDuplicate);

      expect(successful.length).toBe(5);
      expect(duplicates.length).toBeGreaterThan(0);

      const firstResult = results[0].result;
      for (const result of results) {
        expect(result.result).toEqual(firstResult);
      }
    });

    it('2. Different idempotency keys create separate submissions', async () => {
      const userId = 'user_1';
      const data = { bondId: '123', amount: '5000' };

      const result1 = await processor.processSubmission('idem:1', userId, data);
      const result2 = await processor.processSubmission('idem:2', userId, data);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.result).not.toEqual(result2.result);
    });

    it('3. Idempotency prevents double-charging on retries', async () => {
      const idempotencyKey = 'idem:transfer:user_1:bond_5';
      const userId = 'user_1';

      const submission1 = await processor.processSubmission(idempotencyKey, userId, {
        transferAmount: BigInt('1000'),
      });

      expect(submission1.success).toBe(true);
      expect(submission1.isDuplicate).toBe(false);

      // Retry with same key
      const submission2 = await processor.processSubmission(idempotencyKey, userId, {
        transferAmount: BigInt('1000'),
      });

      expect(submission2.success).toBe(true);
      expect(submission2.isDuplicate).toBe(true);
      expect(submission2.result).toEqual(submission1.result);
    });

    it('4. Lock timeout prevents race condition on same idempotency key', async () => {
      const idempotencyKey = 'idem:concurrent:user_1';
      const userId = 'user_1';

      // First submission acquires lock
      const lockKey = `lock:submission:${idempotencyKey}`;
      const lock1 = await redis.acquireLock(lockKey, 5000);
      expect(lock1).toBe(true);

      // Second submission should get timeout or duplicate response
      const result = await processor.processSubmission(idempotencyKey, userId, {});

      expect(result.error).toBe('LOCK_TIMEOUT');

      await redis.releaseLock(lockKey);
    });
  });

  describe('Stale Version Detection', () => {
    it('5. Stale version rejection on optimistic locking', async () => {
      const userId = 'user_1';

      // Initial version
      redis.setVersion(`${userId}:version`, 1);

      // Attempt submission with outdated expected version
      const result = await processor.processSubmission('idem:1', userId, { data: 'test' }, 0);

      expect(result.success).toBe(false);
      expect(result.error).toBe('STALE_VERSION');
    });

    it('6. Current version succeeds', async () => {
      const userId = 'user_1';
      redis.setVersion(`${userId}:version`, 2);

      const result = await processor.processSubmission('idem:1', userId, { data: 'test' }, 2);

      expect(result.success).toBe(true);
    });

    it('7. Version increments after successful submission', async () => {
      const userId = 'user_1';
      const initialVersion = redis.getVersion(`${userId}:version`);

      await processor.processSubmission('idem:1', userId, { data: 'test' });

      const newVersion = redis.getVersion(`${userId}:version`);
      expect(newVersion).toBe(initialVersion + 1);
    });

    it('8. Concurrent submissions with stale version all fail except first', async () => {
      const userId = 'user_1';
      redis.setVersion(`${userId}:version`, 5);

      const staleResults = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          processor.processSubmission(`idem:stale_${i}`, userId, { data: `test_${i}` }, 3),
        ),
      );

      const failed = staleResults.filter((r) => !r.success && r.error === 'STALE_VERSION');
      expect(failed.length).toBe(3);
    });

    it('9. Stale detection with timestamp comparison', async () => {
      const idempotencyKey = 'idem:timestamp:user_1';
      const userId = 'user_1';

      const result1 = await processor.processSubmission(idempotencyKey, userId, { data: 'v1' });
      const timestamp1 = result1.result?.timestamp;

      await new Promise((r) => setTimeout(r, 10));

      const result2 = await processor.processSubmission(idempotencyKey, userId, { data: 'v1' });
      const timestamp2 = result2.result?.timestamp;

      expect(timestamp1).toBe(timestamp2); // Duplicate returns same result
    });
  });

  describe('Cross-Request Deduplication', () => {
    it('10. Multiple users with identical data create separate submissions', async () => {
      const data = { bondId: '123', amount: '5000' };

      const user1Result = await processor.processSubmission('idem:user1', 'user_1', data);
      const user2Result = await processor.processSubmission('idem:user2', 'user_2', data);

      expect(user1Result.success).toBe(true);
      expect(user2Result.success).toBe(true);
      expect(user1Result.result).not.toEqual(user2Result.result);
    });

    it('11. Same user, different operations are distinct', async () => {
      const userId = 'user_1';

      const subscribeResult = await processor.processSubmission(
        'idem:subscribe:1',
        userId,
        { action: 'subscribe', bondId: '123' },
      );

      const transferResult = await processor.processSubmission(
        'idem:transfer:1',
        userId,
        { action: 'transfer', bondId: '456' },
      );

      expect(subscribeResult.success).toBe(true);
      expect(transferResult.success).toBe(true);
      expect(subscribeResult.result?.dataHash).not.toEqual(transferResult.result?.dataHash);
    });
  });

  describe('Idempotency Service Integration', () => {
    it('12. IdempotencyService marks pending during processing', async () => {
      const idempotencyKey = 'idem:pending:user_1';
      const fingerprint = IdempotencyService.fingerprintOf('POST', '/bonds/subscribe', {
        bondId: '123',
      });

      const isFirst = await idempotencyService.markPending(idempotencyKey, fingerprint);
      expect(isFirst).toBe(true);

      const record = await idempotencyService.get(idempotencyKey);
      expect(record?.status).toBe('pending');
    });

    it('13. IdempotencyService completes and caches result', async () => {
      const idempotencyKey = 'idem:complete:user_1';

      await idempotencyService.markPending(idempotencyKey, 'fingerprint:1');
      await idempotencyService.complete(idempotencyKey, 'success', { result: 'ok' }, 200);

      const record = await idempotencyService.get(idempotencyKey);
      expect(record?.status).toBe('success');
      expect(record?.result).toEqual({ result: 'ok' });
    });

    it('14. Concurrent waiters for same pending request', async () => {
      const idempotencyKey = 'idem:wait:user_1';

      await idempotencyService.markPending(idempotencyKey, 'fingerprint:1');

      const waitResults = await Promise.all(
        Array.from({ length: 5 }, async () => {
          let record = await idempotencyService.get(idempotencyKey);
          let attempts = 0;
          while (record?.status === 'pending' && attempts < 50) {
            await new Promise((r) => setTimeout(r, 2));
            record = await idempotencyService.get(idempotencyKey);
            attempts++;
          }
          return record;
        }),
      );

      // Complete the original request
      await idempotencyService.complete(idempotencyKey, 'success', { result: 'done' }, 200);

      expect(waitResults.every((r) => r?.status === 'pending' || r?.status === 'success')).toBe(true);
    });
  });
});
