import { IdempotencyService } from '../services/idempotency.service';
import { RedisService } from '../services/redis.service';
import { ActorScopedIdempotency, type ActorSubmission } from './actor-scoped-idempotency';

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
 * Concurrency tests for duplicate submissions against the *real*
 * IdempotencyService (contributor slice). The existing #423 suite exercises a
 * simulated processor; this suite drives the production claim/retry state
 * machine, including the actor namespace that prevents cross-user replay.
 */

class MemoryRedis extends RedisService {
  readonly store = new Map<string, string>();
  /** When true, reservations silently fail and reads return null (outage). */
  outage = false;
  writes = 0;

  async get(key: string): Promise<string | null> {
    return this.outage ? null : (this.store.get(key) ?? null);
  }

  async setNxValue(key: string, value: string, _seconds: number): Promise<boolean> {
    this.writes++;
    if (this.outage || this.store.has(key)) return false;
    this.store.set(key, value);
    return true;
  }

  async setEx(key: string, _seconds: number, value: string): Promise<void> {
    this.writes++;
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe('Actor-scoped duplicate submission lifecycle (contributor slice)', () => {
  let redis: MemoryRedis;
  let guard: ActorScopedIdempotency;
  let sideEffects: string[];

  const submission = (overrides: Partial<ActorSubmission> = {}): ActorSubmission => ({
    key: 'subscribe-bond-1',
    actorId: 'investor-A',
    method: 'POST',
    path: '/api/bonds/1/subscribe',
    body: { amount: 100 },
    ...overrides,
  });

  /** One full submit attempt: claim, then execute exactly once if permitted. */
  const submit = async (sub: ActorSubmission, result: string) => {
    const decision = await guard.begin(sub);
    if (decision.decision === 'execute') {
      sideEffects.push(result);
      await guard.complete(sub, { result });
    }
    return { ...decision, result };
  };

  beforeEach(() => {
    redis = new MemoryRedis();
    guard = new ActorScopedIdempotency(new IdempotencyService(redis));
    sideEffects = [];
  });

  describe('normal paths', () => {
    it('runs the mutation once for concurrent identical submissions', async () => {
      const sub = submission();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => submit(sub, `winner-${i}`)));

      expect(sideEffects).toHaveLength(1);
      expect(results.filter((r) => r.decision === 'execute')).toHaveLength(1);
      expect(results.filter((r) => r.decision === 'conflict')).toHaveLength(19);
    });

    it('replays the stored result on a later retry instead of re-executing', async () => {
      const sub = submission();
      await submit(sub, 'first');

      const replay = await guard.begin(sub);

      expect(replay.decision).toBe('replay');
      expect(replay.result).toEqual({ result: 'first' });
      expect(sideEffects).toEqual(['first']);
    });

    it('treats a different payload with the same key as a conflict', async () => {
      const sub = submission();
      await submit(sub, 'first');

      const changed = await guard.begin(submission({ body: { amount: 200 } }));

      expect(changed.decision).toBe('conflict');
      expect(sideEffects).toEqual(['first']);
    });
  });

  describe('failure paths', () => {
    it('records a failed attempt and allows the same key to be retried', async () => {
      const sub = submission();
      const first = await guard.begin(sub);
      expect(first.decision).toBe('execute');
      await guard.fail(sub, new Error('RPC timeout'), 503);

      const retry = await guard.begin(sub);
      expect(retry.decision).toBe('execute');
      sideEffects.push('after-retry');
      await guard.complete(sub, { result: 'after-retry' });

      expect((await guard.begin(sub)).decision).toBe('replay');
      expect(sideEffects).toEqual(['after-retry']);
    });

    it('fails closed when idempotency state cannot be reserved or read', async () => {
      redis.outage = true;
      const decision = await guard.begin(submission());

      expect(decision.decision).toBe('conflict');
      expect(sideEffects).toEqual([]);
    });

    it('refuses a payload change while an error record is being retried', async () => {
      const sub = submission();
      await guard.fail(sub, new Error('downstream failed'));

      const decision = await guard.begin(submission({ body: { amount: 999 } }));

      expect(decision.decision).toBe('conflict');
    });
  });

  describe('retry paths', () => {
    it('lets exactly one of many concurrent retries run after a failure', async () => {
      const sub = submission();
      await guard.fail(sub, new Error('temporary failure'));

      const decisions = await Promise.all(
        Array.from({ length: 12 }, (_, i) => submit(sub, `retry-${i}`)),
      );

      expect(decisions.filter((d) => d.decision === 'execute')).toHaveLength(1);
      expect(decisions.filter((d) => d.decision === 'conflict')).toHaveLength(11);
      expect(sideEffects).toHaveLength(1);
    });

    it('a second failure can itself be retried (claim is released)', async () => {
      const sub = submission();
      await guard.fail(sub, new Error('first failure'));
      const winner = await guard.begin(sub);
      expect(winner.decision).toBe('execute');
      await guard.fail(sub, new Error('second failure'));

      expect((await guard.begin(sub)).decision).toBe('execute');
    });
  });

  describe('authorization paths', () => {
    it('isolates identical keys and payloads belonging to different actors', async () => {
      const alice = submission({ actorId: 'investor-A' });
      const bob = submission({ actorId: 'investor-B' });

      await submit(alice, 'alice-result');
      const bobDecision = await guard.begin(bob);

      expect(bobDecision.decision).toBe('execute');
      sideEffects.push('bob-result');
      await guard.complete(bob, { result: 'bob-result' });
      const aliceReplay = await guard.begin(alice);

      expect(aliceReplay.result).toEqual({ result: 'alice-result' });
      expect(sideEffects).toEqual(['alice-result', 'bob-result']);
    });

    it('does not leak the raw actor id into storage keys', () => {
      const sub = submission({ actorId: 'investor-A' });
      const key = ActorScopedIdempotency.scopedKey(sub);

      expect(key).toMatch(/^actor:[0-9a-f]{64}:subscribe-bond-1$/);
      expect(key).not.toContain('investor-A');
      expect(ActorScopedIdempotency.scopedKey(sub)).toBe(key);
    });

    it('separates different idempotency keys for the same actor', async () => {
      const first = submission({ key: 'subscribe-1' });
      const second = submission({ key: 'subscribe-2' });

      expect((await guard.begin(first)).decision).toBe('execute');
      expect((await guard.begin(second)).decision).toBe('execute');
    });
  });
});
