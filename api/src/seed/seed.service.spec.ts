import { SeedService } from './seed.service';
import { RedisService } from '../common/services/redis.service';

function mockRedis(): { store: Map<string, string>; service: RedisService } {
  const store = new Map<string, string>();
  const service = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key);
    }),
    delPattern: jest.fn(async (pattern: string) => {
      for (const key of Array.from(store.keys())) {
        if (key.startsWith(pattern.replace('*', ''))) store.delete(key);
      }
    }),
    sAdd: jest.fn(),
    sMembers: jest.fn(async () => []),
    isHealthy: jest.fn(() => true),
  } as unknown as RedisService;
  return { store, service };
}

describe('SeedService', () => {
  it('writes deterministic fixtures to cache keys on first run', async () => {
    const { store, service } = mockRedis();
    const seed = new SeedService(service);

    const summary = await seed.seed();

    expect(summary.wasSkipped).toBe(false);
    expect(store.has('project:1')).toBe(true);
    expect(store.has('projects:1:20')).toBe(true);
    expect(store.has('bond:1')).toBe(true);
    expect(store.has('bonds:1:20')).toBe(true);
    expect(store.has('order:1')).toBe(true);
    expect(store.has('orders:all:all:1:20')).toBe(true);
    expect(store.has('reports:1')).toBe(true);
    expect(store.has('oracle:providers')).toBe(true);
    expect(summary.totals.cacheKeysWritten).toBeGreaterThan(0);
  });

  it('is idempotent: second run without force is skipped', async () => {
    const { store, service } = mockRedis();
    const seed = new SeedService(service);

    await seed.seed(false);
    const keysBefore = store.size;
    const second = await seed.seed(false);

    expect(second.wasSkipped).toBe(true);
    expect(store.size).toBe(keysBefore);
  });

  it('re-applies fixtures when forced', async () => {
    const { store, service } = mockRedis();
    const seed = new SeedService(service);

    await seed.seed(false);
    const summary = await seed.seed(true);

    expect(summary.wasSkipped).toBe(false);
    expect(store.has('bond:1')).toBe(true);
  });

  it('reset clears all seeded keys and the marker', async () => {
    const { store, service } = mockRedis();
    const seed = new SeedService(service);

    await seed.seed(false);
    await seed.reset();

    expect(store.has('project:1')).toBe(false);
    expect(store.has('bonds:1:20')).toBe(false);
    expect(store.has('orders:all:all:1:20')).toBe(false);
  });

  it('produces a stable dataset across runs (deterministic)', async () => {
    const { buildSeedDataset } = await import('./fixtures');
    const now = Date.UTC(2026, 0, 15);
    const a = buildSeedDataset(now);
    const b = buildSeedDataset(now);

    expect(a.projects.map((p) => p.name)).toEqual(b.projects.map((p) => p.name));
    expect(a.bonds.map((bd) => bd.id)).toEqual(b.bonds.map((bd) => bd.id));
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
