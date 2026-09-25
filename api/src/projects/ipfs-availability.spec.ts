import { IpfsAvailabilityService } from './ipfs-availability.service';
import { IpfsDocumentCacheService } from './ipfs-document-cache.service';
import { RedisService } from '../common/services/redis.service';

describe('IpfsAvailabilityService (Proactive Scheduled Monitoring)', () => {
  let availabilityService: IpfsAvailabilityService;
  let cacheService: IpfsDocumentCacheService;
  let mockRedis: Record<string, string>;
  let mockSets: Record<string, Set<string>>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    mockRedis = {};
    mockSets = {};
    originalFetch = global.fetch;

    const redisService: Partial<RedisService> = {
      setEx: jest.fn(async (key: string, _ttl: number, value: string) => {
        mockRedis[key] = value;
      }),
      get: jest.fn(async (key: string) => {
        return mockRedis[key] || null;
      }),
      sAdd: jest.fn(async (key: string, value: string) => {
        if (!mockSets[key]) mockSets[key] = new Set();
        mockSets[key].add(value);
      }),
      sMembers: jest.fn(async (key: string) => {
        return mockSets[key] ? Array.from(mockSets[key]) : [];
      }),
    };

    cacheService = new IpfsDocumentCacheService(redisService as RedisService);
    availabilityService = new IpfsAvailabilityService(
      redisService as RedisService,
      cacheService,
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reports "available" when primary gateway responds with 200', async () => {
    const hash = 'QmHealthyHash1';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

    const health = await availabilityService.checkDocumentAvailability(hash, false);
    expect(health.status).toBe('available');
    expect(health.primaryGatewayOk).toBe(true);
    expect(health.failureCount).toBe(0);
  });

  it('reports "degraded" and warms cache when primary gateway fails but fallback gateway succeeds', async () => {
    const hash = 'QmDegradedAuditHash';

    // Primary gateway (Pinata) fails, fallback (ipfs.io) succeeds
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('pinata')) {
        return { ok: false, status: 504 } as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => Buffer.from(JSON.stringify({ verified: true })),
      } as unknown as Response;
    });

    const health = await availabilityService.checkDocumentAvailability(hash, true);
    expect(health.status).toBe('degraded');
    expect(health.primaryGatewayOk).toBe(false);
    expect(health.fallbackGatewayOk).toBe(true);
  });

  it('reports "cached_fallback" when all gateways fail but document exists in local cache', async () => {
    const hash = 'QmCachedOnlyHash';
    await cacheService.cacheDocument(hash, 'Certification data', {
      isAuditRelevant: true,
    });

    // All gateways fail
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 } as Response);

    const health = await availabilityService.checkDocumentAvailability(hash, true);
    expect(health.status).toBe('cached_fallback');
    expect(health.primaryGatewayOk).toBe(false);
    expect(health.fallbackGatewayOk).toBe(false);
    expect(health.servedByCache).toBe(true);
  });

  it('reports "unavailable" when all gateways fail and no cache is present', async () => {
    const hash = 'QmTotallyLostHash';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 } as Response);

    const health = await availabilityService.checkDocumentAvailability(hash, false);
    expect(health.status).toBe('unavailable');
    expect(health.servedByCache).toBe(false);
    expect(health.failureCount).toBe(1);
  });

  it('executes scheduled audit check for all registered audit-relevant hashes', async () => {
    // Register audit hashes
    mockSets['ipfs:cache:audit_relevant_hashes'] = new Set([
      'QmAuditDocA',
      'QmAuditDocB',
    ]);

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response);

    await availabilityService.runScheduledAvailabilityAudit();

    // Verify health was stored for both audit documents
    expect(mockRedis['ipfs:health:QmAuditDocA']).toBeDefined();
    expect(mockRedis['ipfs:health:QmAuditDocB']).toBeDefined();
  });
});
