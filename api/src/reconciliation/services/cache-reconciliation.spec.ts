import { Permission, Role, RolePermissions } from '../../auth/rbac';
import { ReconciliationService } from './reconciliation.service';
import {
  applyCacheRepairPlan,
  CachedEntry,
  CacheRepairForbiddenError,
  CacheStore,
  cacheReconciliationInvariant,
  canonicalDigest,
  diffSourceAndCache,
  SourceEntry,
  toReconciliationReport,
} from './cache-reconciliation';

/** In-memory cache with scripted failures: `failures[op:key]` = how many calls throw. */
class FlakyCache implements CacheStore {
  readonly entries = new Map<string, CachedEntry>();
  readonly failures = new Map<string, { remaining: number; retryable?: boolean }>();

  constructor(seed: CachedEntry[] = []) {
    seed.forEach((entry) => this.entries.set(entry.key, entry));
  }

  failNext(op: 'get' | 'set' | 'delete', key: string, times: number, retryable?: boolean): void {
    this.failures.set(`${op}:${key}`, { remaining: times, retryable });
  }

  private maybeFail(op: string, key: string): void {
    const failure = this.failures.get(`${op}:${key}`);
    if (failure && failure.remaining > 0) {
      failure.remaining -= 1;
      throw Object.assign(new Error(`${op} ${key} unavailable`), { retryable: failure.retryable });
    }
  }

  async get(key: string) {
    this.maybeFail('get', key);
    return this.entries.get(key);
  }

  async set(key: string, entry: CachedEntry) {
    this.maybeFail('set', key);
    this.entries.set(key, entry);
  }

  async delete(key: string) {
    this.maybeFail('delete', key);
    this.entries.delete(key);
  }

  snapshot(): CachedEntry[] {
    return [...this.entries.values()];
  }
}

const operator = { userId: 'ops-1', permissions: RolePermissions[Role.SETTLEMENT_MANAGER] };
const noSleep = async () => undefined;

const source: SourceEntry[] = [
  { key: 'bond:1', value: { id: 1, status: 'ACTIVE', supply: '1000' }, version: 5 },
  { key: 'bond:2', value: { id: 2, status: 'MATURED', supply: '500' }, version: 9 },
  { key: 'bond:3', value: { id: 3, status: 'ACTIVE', supply: '50' }, version: 2 },
];

describe('source/cache reconciliation (#507)', () => {
  describe('canonicalDigest', () => {
    it('ignores key order and undefined fields but not values', () => {
      expect(canonicalDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalDigest({ b: { d: 3, c: 2 }, a: 1 }));
      expect(canonicalDigest({ a: 1, x: undefined })).toBe(canonicalDigest({ a: 1 }));
      expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: '1' }));
    });
  });

  describe('diffSourceAndCache', () => {
    it('reports HEALTHY with an empty plan when cache matches source (normal path)', () => {
      const diff = diffSourceAndCache('bond', source, source.map((entry) => ({ ...entry, value: { ...(entry.value as object) } })));

      expect(diff.drifts).toEqual([]);
      expect(diff.plan).toEqual([]);
      expect(diff.totalEntitiesChecked).toBe(3);
      expect(toReconciliationReport(diff, true).status).toBe('HEALTHY');
    });

    it('classifies missing, stale (value and version), and orphaned keys', () => {
      const cached: CachedEntry[] = [
        { key: 'bond:1', value: { id: 1, status: 'ACTIVE', supply: '999' }, version: 5 }, // value drift
        { key: 'bond:2', value: { id: 2, status: 'MATURED', supply: '500' }, version: 8 }, // version behind
        { key: 'bond:99', value: { id: 99 }, version: 1 }, // orphan
      ];

      const diff = diffSourceAndCache('bond', source, cached);

      expect(diff.plan).toEqual([
        { kind: 'set', key: 'bond:1', value: source[0].value, version: 5, reason: 'stale' },
        { kind: 'set', key: 'bond:2', value: source[1].value, version: 9, reason: 'stale' },
        { kind: 'set', key: 'bond:3', value: source[2].value, version: 2, reason: 'missing' },
        { kind: 'delete', key: 'bond:99', reason: 'orphaned' },
      ]);
      const report = toReconciliationReport(diff, true);
      expect(report.summary).toEqual({ missingCount: 1, orphanedCount: 1, duplicateCount: 0, staleCount: 2, inconsistentCount: 0 });
      expect(report.status).toBe('DEGRADED');
      expect(report.totalEntitiesChecked).toBe(4);
    });

    it('flags a cache that is ahead of source and never plans to roll it back', () => {
      const diff = diffSourceAndCache('bond', [source[0]], [{ ...source[0], value: { id: 1, status: 'MATURED' }, version: 6 }]);

      expect(diff.plan).toEqual([]);
      expect(diff.drifts).toHaveLength(1);
      expect(diff.drifts[0]).toMatchObject({ type: 'inconsistent', severity: 'HIGH', expectedValue: 5, actualValue: 6 });
      expect(toReconciliationReport(diff, true).status).toBe('CRITICAL');
    });

    it('reports duplicate source keys and leaves them untouched', () => {
      const diff = diffSourceAndCache('bond', [source[0], { ...source[0], value: { id: 1, status: 'X' } }], []);

      expect(diff.plan).toEqual([]);
      expect(diff.drifts).toEqual([expect.objectContaining({ type: 'duplicate', entityId: 'bond:1' })]);
    });

    it('rewrites a key the cache holds twice', () => {
      const diff = diffSourceAndCache('bond', [source[0]], [source[0], source[0]]);

      expect(diff.plan).toEqual([expect.objectContaining({ kind: 'set', key: 'bond:1', reason: 'stale' })]);
    });

    it('compares by value when either side lacks a version', () => {
      const diff = diffSourceAndCache('project', [{ key: 'p:1', value: { cid: 'a' } }], [{ key: 'p:1', value: { cid: 'b' }, version: 3 }]);

      expect(diff.plan).toEqual([{ kind: 'set', key: 'p:1', value: { cid: 'a' }, version: undefined, reason: 'stale' }]);
    });
  });

  describe('applyCacheRepairPlan', () => {
    const drifted = (): FlakyCache =>
      new FlakyCache([
        { key: 'bond:1', value: { id: 1, status: 'ACTIVE', supply: '999' }, version: 5 },
        { key: 'bond:99', value: { id: 99 }, version: 1 },
      ]);

    it('defaults to dry-run and writes nothing', async () => {
      const cache = drifted();
      const before = cache.snapshot();
      const { plan } = diffSourceAndCache('bond', source, cache.snapshot());

      const result = await applyCacheRepairPlan(plan, cache, { actor: operator });

      expect(result).toMatchObject({ status: 'dry-run', planned: 4, applied: 0 });
      expect(cache.snapshot()).toEqual(before);
    });

    it('converges the cache to source, and a second pass finds nothing (normal path, idempotent)', async () => {
      const cache = drifted();
      const { plan } = diffSourceAndCache('bond', source, cache.snapshot());

      const result = await applyCacheRepairPlan(plan, cache, { actor: operator, dryRun: false, sleep: noSleep });

      expect(result).toMatchObject({ status: 'applied', planned: 4, applied: 4, retries: 0 });
      expect(diffSourceAndCache('bond', source, cache.snapshot()).drifts).toEqual([]);
    });

    it('retries transient cache errors with backoff and still converges (retry path)', async () => {
      const cache = drifted();
      cache.failNext('set', 'bond:3', 2);
      cache.failNext('get', 'bond:99', 1);
      const sleep = jest.fn().mockResolvedValue(undefined);
      const { plan } = diffSourceAndCache('bond', source, cache.snapshot());

      const result = await applyCacheRepairPlan(plan, cache, { actor: operator, dryRun: false, baseDelayMs: 10, sleep });

      expect(result).toMatchObject({ status: 'applied', applied: 4, retries: 3 });
      expect(sleep.mock.calls).toEqual([[10], [20], [10]]);
      expect(diffSourceAndCache('bond', source, cache.snapshot()).drifts).toEqual([]);
    });

    it('rolls back every applied action when one exhausts its retries (failure path)', async () => {
      const cache = drifted();
      const before = cache.snapshot();
      cache.failNext('delete', 'bond:99', 5);
      const { plan } = diffSourceAndCache('bond', source, cache.snapshot());

      const result = await applyCacheRepairPlan(plan, cache, { actor: operator, dryRun: false, maxAttempts: 3, sleep: noSleep });

      expect(result.status).toBe('rolled-back');
      expect(result.applied).toBe(0);
      expect(result.error).toContain('bond:99');
      // bond:1 restored to its stale value, bond:2/bond:3 (absent before) removed again.
      expect(cache.snapshot()).toEqual(before);
    });

    it('does not retry errors marked non-retryable', async () => {
      const cache = drifted();
      cache.failNext('set', 'bond:1', 1, false);
      const sleep = jest.fn().mockResolvedValue(undefined);
      const { plan } = diffSourceAndCache('bond', source, cache.snapshot());

      const result = await applyCacheRepairPlan(plan, cache, { actor: operator, dryRun: false, sleep });

      expect(result.status).toBe('rolled-back');
      expect(sleep).not.toHaveBeenCalled();
    });

    it('reports keys it could not restore when rollback itself fails', async () => {
      const cache = drifted();
      cache.failNext('delete', 'bond:99', 5);
      const { plan } = diffSourceAndCache('bond', source, cache.snapshot());
      // bond:1 is written first; make restoring it fail too.
      const realSet = cache.set.bind(cache);
      let bond1Writes = 0;
      cache.set = async (key, entry) => {
        if (key === 'bond:1' && ++bond1Writes > 1) throw new Error('restore refused');
        return realSet(key, entry);
      };

      const result = await applyCacheRepairPlan(plan, cache, { actor: operator, dryRun: false, maxAttempts: 2, sleep: noSleep });

      expect(result.status).toBe('rollback-failed');
      expect(result.unrestoredKeys).toEqual(['bond:1']);
    });

    describe('authorization', () => {
      it.each([
        ['investor', { userId: 'inv', permissions: RolePermissions[Role.INVESTOR] }],
        ['issuer', { userId: 'iss', permissions: RolePermissions[Role.ISSUER] }],
        ['no permissions', { userId: 'x', permissions: [] }],
      ])('refuses %s even for a dry-run', async (_label, actor) => {
        const cache = drifted();
        const { plan } = diffSourceAndCache('bond', source, cache.snapshot());

        await expect(applyCacheRepairPlan(plan, cache, { actor, dryRun: false })).rejects.toThrow(CacheRepairForbiddenError);
        await expect(applyCacheRepairPlan(plan, cache, { actor })).rejects.toThrow(Permission.RECONCILE_CACHE);
      });

      it('refuses a missing actor', async () => {
        await expect(applyCacheRepairPlan([], new FlakyCache(), { actor: undefined as any })).rejects.toThrow('anonymous');
      });

      it('grants maintainers and settlement managers', () => {
        expect(RolePermissions[Role.MAINTAINER]).toContain(Permission.RECONCILE_CACHE);
        expect(RolePermissions[Role.SETTLEMENT_MANAGER]).toContain(Permission.RECONCILE_CACHE);
      });
    });
  });

  describe('integration with ReconciliationService', () => {
    it('surfaces cache drift through the existing dry-run report contract', async () => {
      const service = new ReconciliationService();
      service.registerInvariant(
        cacheReconciliationInvariant('bond', async () => source, async () => [source[0], { key: 'bond:99', value: {} }]),
      );

      const report = await service.runDryRun();

      expect(report.status).toBe('DEGRADED');
      expect(report.summary).toMatchObject({ missingCount: 2, orphanedCount: 1 });
    });

    it('turns a failing loader into an inconsistent drift rather than crashing the run', async () => {
      const service = new ReconciliationService();
      const invariant = cacheReconciliationInvariant('bond', async () => {
        throw new Error('rpc down');
      }, async () => []);
      service.registerInvariant(invariant);

      const report = await service.runDryRun();

      expect(invariant.name).toBe('CACHE_CONSISTENCY_BOND');
      expect(report.status).toBe('CRITICAL');
      expect(report.driftsFound[0].description).toContain('rpc down');
    });
  });
});
