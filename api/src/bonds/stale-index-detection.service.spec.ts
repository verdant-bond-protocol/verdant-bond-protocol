import { StaleIndexDetectionService } from './stale-index-detection.service';
import { HolderIndexService } from './holder-index.service';
import { InMemoryHolderStore } from './holder-store';

// Force in-memory store for tests.
process.env.HOLDER_INDEX_STORE = 'memory';

const WARN_MS = 1_800_000; // 30 min
const STALE_MS = 3_600_000; // 60 min
const NOW = 1_700_000_000_000; // fixed clock

function makeStore(overrides?: {
  lastReconciled?: Record<number, number>;
  holders?: Record<number, string[]>;
}): InMemoryHolderStore {
  const store = new InMemoryHolderStore();
  if (overrides?.holders) {
    for (const [id, addrs] of Object.entries(overrides.holders)) {
      store.setHolders(Number(id), addrs);
    }
  }
  if (overrides?.lastReconciled) {
    for (const [id, ts] of Object.entries(overrides.lastReconciled)) {
      store.touch(Number(id), ts);
    }
  }
  return store;
}

function makeService(store: InMemoryHolderStore, redisMembers: Record<number, string[]> = {}) {
  const holderIndexService = {
    getStore: jest.fn().mockReturnValue(store),
  } as unknown as HolderIndexService;

  const redis = {
    sMembers: jest.fn(async (key: string) => {
      const match = key.match(/bond:(\d+):holders/);
      if (!match) return [];
      return redisMembers[Number(match[1])] ?? [];
    }),
  };

  return new StaleIndexDetectionService(
    holderIndexService,
    redis as any,
  );
}

describe('StaleIndexDetectionService', () => {
  it('returns OK when all bonds are freshly reconciled and cache is warm', async () => {
    const store = makeStore({ lastReconciled: { 1: NOW - 60_000, 2: NOW - 120_000 } });
    const service = makeService(store, { 1: ['ADDR1'], 2: ['ADDR2'] });

    const report = await service.scan([1, 2], NOW, WARN_MS, STALE_MS);

    expect(report.health).toBe('OK');
    expect(report.findings).toHaveLength(0);
    expect(report.staleIndexCount).toBe(0);
    expect(report.unseededCount).toBe(0);
    expect(report.staleCacheCount).toBe(0);
  });

  it('marks a bond UNSEEDED when it has never been reconciled', async () => {
    const store = makeStore(); // lastReconciled = 0 for all
    const service = makeService(store);

    const report = await service.scan([1], NOW, WARN_MS, STALE_MS);

    expect(report.health).toBe('CRITICAL');
    expect(report.unseededCount).toBe(1);
    const finding = report.findings[0];
    expect(finding.severity).toBe('UNSEEDED');
    expect(finding.lastReconciledAtIso).toBe('never');
    expect(finding.repairAction.automatable).toBe(false);
    expect(finding.repairAction.command).toContain('reindex');
  });

  it('marks a bond STALE when index age exceeds staleMs', async () => {
    const store = makeStore({ lastReconciled: { 1: NOW - STALE_MS - 1 } });
    const service = makeService(store, { 1: ['ADDR1'] });

    const report = await service.scan([1], NOW, WARN_MS, STALE_MS);

    expect(report.health).toBe('CRITICAL');
    expect(report.staleIndexCount).toBe(1);
    const finding = report.findings[0];
    expect(finding.severity).toBe('STALE');
    expect(finding.repairAction.automatable).toBe(true);
    expect(finding.repairAction.command).toContain('reconcile');
  });

  it('marks a bond WARNING when index is fresh but Redis cache is empty', async () => {
    const store = makeStore({ lastReconciled: { 1: NOW - 60_000 } });
    // Redis returns empty members for bond 1
    const service = makeService(store, { 1: [] });

    const report = await service.scan([1], NOW, WARN_MS, STALE_MS);

    expect(report.health).toBe('DEGRADED');
    expect(report.staleCacheCount).toBe(1);
    const finding = report.findings[0];
    expect(finding.severity).toBe('WARNING');
    expect(finding.repairAction.command).toContain('warm-cache');
    expect(finding.repairAction.automatable).toBe(true);
  });

  it('marks a bond WARNING when index age is between warnMs and staleMs', async () => {
    const ageMs = WARN_MS + 60_000; // past warning, before stale
    const store = makeStore({ lastReconciled: { 1: NOW - ageMs } });
    const service = makeService(store, { 1: ['ADDR1'] });

    const report = await service.scan([1], NOW, WARN_MS, STALE_MS);

    expect(report.health).toBe('DEGRADED');
    const finding = report.findings[0];
    expect(finding.severity).toBe('WARNING');
    expect(finding.repairAction.command).toContain('reconcile');
  });

  it('handles Redis errors gracefully and counts the bond as stale-cache', async () => {
    const store = makeStore({ lastReconciled: { 1: NOW - 60_000 } });
    const redis = { sMembers: jest.fn().mockRejectedValue(new Error('Redis down')) };
    const holderIndexService = { getStore: jest.fn().mockReturnValue(store) } as unknown as HolderIndexService;
    const service = new StaleIndexDetectionService(holderIndexService, redis as any);

    const report = await service.scan([1], NOW, WARN_MS, STALE_MS);

    expect(report.staleCacheCount).toBe(1);
    expect(report.findings[0].severity).toBe('WARNING');
  });

  it('reports correct aggregate counts across mixed-health bonds', async () => {
    const store = makeStore({
      lastReconciled: {
        1: NOW - 60_000,          // fresh + warm -> OK
        2: NOW - STALE_MS - 1,   // stale index -> CRITICAL
        // bond 3 not touched -> UNSEEDED -> CRITICAL
      },
    });
    const service = makeService(store, { 1: ['ADDR1'], 2: ['ADDR2'] });

    const report = await service.scan([1, 2, 3], NOW, WARN_MS, STALE_MS);

    expect(report.scannedBonds).toBe(3);
    expect(report.staleIndexCount).toBe(1);
    expect(report.unseededCount).toBe(1);
    expect(report.health).toBe('CRITICAL');
    expect(report.findings).toHaveLength(2);
  });

  it('returns an empty OK report when no bonds are provided', async () => {
    const store = makeStore();
    const service = makeService(store);

    const report = await service.scan([], NOW, WARN_MS, STALE_MS);

    expect(report.health).toBe('OK');
    expect(report.scannedBonds).toBe(0);
    expect(report.findings).toHaveLength(0);
  });
});
