import { BoundedCacheService } from './bounded-cache.service';
import {
  CACHE_REPAIR_PERMISSION,
  CacheRepairForbiddenError,
  CacheSource,
  CacheSourceRecord,
  StaleCacheDetectorService,
} from './stale-cache-detector.service';

type Bond = { id: string; status: string; couponRate?: number };

describe('StaleCacheDetectorService (#531)', () => {
  let cache: BoundedCacheService<Bond>;
  let store: Map<string, CacheSourceRecord<Bond>>;
  let failing: Set<string>;
  let source: CacheSource<Bond>;
  let detector: StaleCacheDetectorService;

  const operator = { id: 'ops-1', permissions: [CACHE_REPAIR_PERMISSION] };

  beforeEach(() => {
    cache = new BoundedCacheService<Bond>(100, 60_000, 1_000);
    store = new Map();
    failing = new Set();
    source = {
      load: async (key: string) => {
        if (failing.has(key)) throw new Error('source timeout');
        return store.get(key) ?? null;
      },
    };
    detector = new StaleCacheDetectorService();
  });

  afterEach(() => jest.restoreAllMocks());

  it('reports a healthy cache when every entry matches its source', async () => {
    store.set('bond:1', { value: { id: '1', status: 'ACTIVE', couponRate: 5 } });
    // Same data, different key order: still fresh.
    cache.set('bond:1', { couponRate: 5, status: 'ACTIVE', id: '1' });

    const report = await detector.scan(cache, source);
    expect(report).toMatchObject({ scanned: 1, fresh: 1, findings: [], health: 'OK' });
  });

  it('classifies stale values, stale versions, orphans and unavailable sources', async () => {
    store.set('bond:1', { value: { id: '1', status: 'MATURED' } });
    cache.set('bond:1', { id: '1', status: 'ACTIVE' });

    store.set('bond:2', { value: { id: '2', status: 'ACTIVE' }, version: 7 });
    cache.set('bond:2', { id: '2', status: 'ACTIVE' }, undefined, { version: 6 });

    cache.set('bond:3', { id: '3', status: 'ACTIVE' }); // deleted at source

    store.set('bond:4', { value: { id: '4', status: 'ACTIVE' } });
    cache.set('bond:4', { id: '4', status: 'ACTIVE' });
    failing.add('bond:4');

    const report = await detector.scan(cache, source);
    const byKey = Object.fromEntries(report.findings.map((f) => [f.key, f]));

    expect(byKey['bond:1']).toMatchObject({ status: 'stale_value', recommendation: { action: 'reload', automatable: true } });
    expect(byKey['bond:2']).toMatchObject({ status: 'stale_version', cachedVersion: 6, sourceVersion: 7 });
    expect(byKey['bond:3']).toMatchObject({ status: 'orphaned', recommendation: { action: 'evict' } });
    expect(byKey['bond:4']).toMatchObject({
      status: 'source_unavailable',
      error: 'source timeout',
      recommendation: { action: 'retry_scan', automatable: false },
    });
    expect(report).toMatchObject({ scanned: 4, fresh: 0, stale: 2, orphaned: 1, unavailable: 1, health: 'CRITICAL' });
  });

  it('trusts matching versions even when the value representation differs', async () => {
    store.set('bond:1', { value: { id: '1', status: 'ACTIVE' }, version: 3 });
    cache.set('bond:1', { id: '1', status: 'active' }, undefined, { version: 3 });
    expect((await detector.scan(cache, source)).health).toBe('OK');
  });

  it('skips expired entries and recommends a prefix invalidation for widespread staleness', async () => {
    for (let i = 0; i < 3; i++) {
      store.set(`holder:${i}`, { value: { id: `${i}`, status: 'NEW' } });
      cache.set(`holder:${i}`, { id: `${i}`, status: 'OLD' });
    }
    cache.set('bond:expired', { id: 'x', status: 'OLD' }, 1);
    const later = Date.now() + 5;
    jest.spyOn(Date, 'now').mockReturnValue(later);

    const report = await detector.scan(cache, source, { prefixThreshold: 3 });
    expect(report.scanned).toBe(3);
    expect(report.prefixRecommendations).toEqual([expect.objectContaining({ prefix: 'holder:', staleKeys: 3 })]);
  });

  describe('repair', () => {
    beforeEach(() => {
      store.set('bond:1', { value: { id: '1', status: 'MATURED' }, version: 2 });
      cache.set('bond:1', { id: '1', status: 'ACTIVE' }, undefined, { version: 1, region: 'eu' });
      cache.set('bond:3', { id: '3', status: 'ACTIVE' });
    });

    it('reloads stale entries and evicts orphans', async () => {
      const report = await detector.scan(cache, source);
      const outcomes = await detector.repair(cache, source, report, operator);

      expect(outcomes).toEqual([
        { key: 'bond:1', action: 'reload', result: 'applied' },
        { key: 'bond:3', action: 'evict', result: 'applied' },
      ]);
      expect(cache.getEntry('bond:1')).toMatchObject({ value: { status: 'MATURED' }, metadata: { version: 2, region: 'eu' } });
      expect(cache.getEntry('bond:3')).toBeNull();
      expect((await detector.scan(cache, source)).health).toBe('OK');
    });

    it('changes nothing in dry-run mode', async () => {
      const report = await detector.scan(cache, source);
      const outcomes = await detector.repair(cache, source, report, operator, { dryRun: true });

      expect(outcomes.map((o) => o.result)).toEqual(['planned', 'planned']);
      expect(cache.getEntry('bond:1')?.value.status).toBe('ACTIVE');
      expect(cache.getEntry('bond:3')).not.toBeNull();
    });

    it('re-reads the source at repair time instead of reusing the scan', async () => {
      const report = await detector.scan(cache, source);
      store.set('bond:3', { value: { id: '3', status: 'RESTORED' } }); // reappeared after the scan

      await detector.repair(cache, source, report, operator);
      expect(cache.getEntry('bond:3')?.value.status).toBe('RESTORED');
    });

    it('leaves an entry untouched when the source fails during repair, and a retry succeeds', async () => {
      const report = await detector.scan(cache, source);
      failing.add('bond:1');

      const first = await detector.repair(cache, source, report, operator);
      expect(first[0]).toEqual({ key: 'bond:1', action: 'reload', result: 'failed', reason: 'source timeout' });
      expect(cache.getEntry('bond:1')?.value.status).toBe('ACTIVE');

      failing.delete('bond:1');
      const retry = await detector.repair(cache, source, await detector.scan(cache, source), operator);
      expect(retry).toEqual([{ key: 'bond:1', action: 'reload', result: 'applied' }]);
    });

    it('skips non-automatable findings and entries evicted since the scan', async () => {
      failing.add('bond:1');
      const report = await detector.scan(cache, source);
      cache.delete('bond:3');

      const outcomes = await detector.repair(cache, source, report, operator);
      expect(outcomes).toEqual([
        { key: 'bond:1', action: 'retry_scan', result: 'skipped', reason: 'requires a new scan' },
        { key: 'bond:3', action: 'evict', result: 'skipped', reason: 'entry no longer cached' },
      ]);
    });

    it('refuses an actor without the repair permission', async () => {
      const report = await detector.scan(cache, source);
      await expect(
        detector.repair(cache, source, report, { id: 'viewer', permissions: [] }),
      ).rejects.toBeInstanceOf(CacheRepairForbiddenError);
      expect(cache.getEntry('bond:1')?.value.status).toBe('ACTIVE');
    });
  });
});
