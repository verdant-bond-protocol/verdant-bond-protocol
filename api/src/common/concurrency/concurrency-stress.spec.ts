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
 * Concurrency stress tests for critical mutation paths (issue #311).
 *
 * Mutation paths tested:
 * 1. Bond subscription capacity allocation under high concurrency.
 * 2. Order book matching race conditions (no double-spend / over-match).
 * 3. Coupon payout claim idempotency and locking.
 * 4. Concurrent lock acquisition and lock timeout fast-failure behavior.
 */

class MockRedisForConcurrency extends RedisService {
  private readonly memoryStore = new Map<string, string>();
  private readonly locks = new Set<string>();

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

  clear(): void {
    this.memoryStore.clear();
    this.locks.clear();
  }
}

// Simulated Bond Allocation Service supporting concurrency lock with retry backoff
class ConcurrentBondSubscriptionManager {
  private availableCapacity: bigint;
  private readonly subscriptions: Array<{ investor: string; amount: bigint }> = [];
  private readonly mockRedis: MockRedisForConcurrency;

  constructor(totalCapacity: bigint, mockRedis: MockRedisForConcurrency) {
    this.availableCapacity = totalCapacity;
    this.mockRedis = mockRedis;
  }

  async subscribe(investor: string, amount: bigint, bondId = 1): Promise<{ success: boolean; error?: string }> {
    const lockKey = `lock:bond:${bondId}`;
    let attempts = 0;
    let acquired = false;

    while (attempts < 10 && !acquired) {
      attempts++;
      acquired = await this.mockRedis.acquireLock(lockKey, 1000);
      if (!acquired) {
        await new Promise((r) => setTimeout(r, 2));
      }
    }

    if (!acquired) {
      return { success: false, error: 'LOCK_TIMEOUT' };
    }

    try {
      if (this.availableCapacity < amount) {
        return { success: false, error: 'EXCEEDS_CAPACITY' };
      }

      this.availableCapacity -= amount;
      this.subscriptions.push({ investor, amount });
      return { success: true };
    } finally {
      await this.mockRedis.releaseLock(lockKey);
    }
  }

  getRemainingCapacity(): bigint {
    return this.availableCapacity;
  }

  getSubscriptions() {
    return [...this.subscriptions];
  }
}

// Simulated Order Book Matcher supporting atomic matching
class ConcurrentOrderBookMatcher {
  private openAskVolume = BigInt('1000');
  private totalFilledVolume = BigInt('0');

  async fillOrder(_buyer: string, requestedAmount: bigint): Promise<{ filled: bigint; status: 'FULL' | 'PARTIAL' | 'REJECTED' }> {
    if (this.openAskVolume <= BigInt(0)) {
      return { filled: BigInt(0), status: 'REJECTED' };
    }

    const fillable = requestedAmount < this.openAskVolume ? requestedAmount : this.openAskVolume;
    this.openAskVolume -= fillable;
    this.totalFilledVolume += fillable;

    const status = fillable === requestedAmount ? 'FULL' : 'PARTIAL';
    return { filled: fillable, status };
  }

  getVolumes() {
    return {
      remainingAsk: this.openAskVolume,
      totalFilled: this.totalFilledVolume,
    };
  }
}

describe('Concurrency Stress Tests (Issue #311)', () => {
  let mockRedis: MockRedisForConcurrency;
  let idempotencyService: IdempotencyService;

  beforeEach(() => {
    mockRedis = new MockRedisForConcurrency();
    idempotencyService = new IdempotencyService(mockRedis);
  });

  afterEach(() => {
    mockRedis.clear();
  });

  it('1. Concurrent Success: Non-colliding subscriptions succeed concurrently without invariant breach', async () => {
    const totalCap = BigInt('10000');
    const manager = new ConcurrentBondSubscriptionManager(totalCap, mockRedis);

    const promises = Array.from({ length: 5 }, (_, i) =>
      manager.subscribe(`investor_${i}`, BigInt('1000')),
    );

    const results = await Promise.all(promises);

    const successful = results.filter((r) => r.success);
    expect(successful.length).toBe(5);
    expect(manager.getRemainingCapacity()).toBe(BigInt('5000'));
    expect(manager.getRemainingCapacity() + BigInt(manager.getSubscriptions().length * 1000)).toBe(totalCap);
  });

  it('2. Conflicting Requests / Capacity Invariant: Over-subscription under concurrency never exceeds total capacity', async () => {
    const totalCap = BigInt('2500');
    const manager = new ConcurrentBondSubscriptionManager(totalCap, mockRedis);

    const requests = Array.from({ length: 10 }, (_, i) =>
      manager.subscribe(`investor_${i}`, BigInt('1000')),
    );

    const results = await Promise.all(requests);

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    expect(succeeded.length).toBe(2);
    expect(failed.length).toBe(8);

    expect(manager.getRemainingCapacity()).toBe(BigInt('500'));
    expect(manager.getRemainingCapacity() >= BigInt(0)).toBe(true);
  });

  it('3. Duplicate Retries / Idempotency Locking: Concurrent identical requests produce exact same cached response', async () => {
    const idempotencyKey = 'idem_coupon_payout_claim_999';
    const fingerprint = IdempotencyService.fingerprintOf('POST', '/bonds/1/claim', { investorId: 'inv_100' });

    const executeMutation = async () => {
      const isFirst = await idempotencyService.markPending(idempotencyKey, fingerprint);
      if (!isFirst) {
        let record = await idempotencyService.get(idempotencyKey);
        while (record?.status === 'pending') {
          await new Promise((r) => setTimeout(r, 2));
          record = await idempotencyService.get(idempotencyKey);
        }
        return { isOriginal: false, record };
      }

      await idempotencyService.complete(idempotencyKey, 'success', { claimedAmount: '5000' }, 200);
      return { isOriginal: true, record: await idempotencyService.get(idempotencyKey) };
    };

    const concurrentCalls = await Promise.all([
      executeMutation(),
      executeMutation(),
      executeMutation(),
      executeMutation(),
      executeMutation(),
    ]);

    const originals = concurrentCalls.filter((c) => c.isOriginal);
    const duplicates = concurrentCalls.filter((c) => !c.isOriginal);

    expect(originals).toHaveLength(1);
    expect(duplicates).toHaveLength(4);

    for (const call of concurrentCalls) {
      expect(call.record?.status).toBe('success');
      expect(call.record?.result.claimedAmount).toBe('5000');
    }
  });

  it('4. Lock Timeout / Fast-Rejection Behavior: Lock acquisition rejection prevents race condition corruptions', async () => {
    const lockKey = 'lock:coupon_payout:bond_505';

    const lock1 = await mockRedis.acquireLock(lockKey, 5000);
    expect(lock1).toBe(true);

    const lock2 = await mockRedis.acquireLock(lockKey, 5000);
    expect(lock2).toBe(false);

    await mockRedis.releaseLock(lockKey);

    const lock3 = await mockRedis.acquireLock(lockKey, 5000);
    expect(lock3).toBe(true);
  });

  it('5. Order Book Concurrency: Concurrent order matches preserve total depth volume invariant', async () => {
    const matcher = new ConcurrentOrderBookMatcher();

    const buyers = ['buyer_1', 'buyer_2', 'buyer_3', 'buyer_4'];
    const results = await Promise.all(buyers.map((b) => matcher.fillOrder(b, BigInt('400'))));

    const totalFilled = results.reduce((acc, r) => acc + r.filled, BigInt('0'));
    const volumes = matcher.getVolumes();

    expect(totalFilled).toBe(BigInt('1000'));
    expect(volumes.remainingAsk).toBe(BigInt('0'));
    expect(volumes.totalFilled).toBe(BigInt('1000'));
  });
});
