import { IpfsService } from './ipfs.service';
import { IpfsUploadPolicy } from './ipfs-upload.policy';
import { IpfsDocumentCacheService } from './ipfs-document-cache.service';
import { RedisService } from '../common/services/redis.service';
import { IpfsUnavailableException } from './interfaces/ipfs-document.interface';

describe('IpfsService Gateway Outage & Cache Fallback', () => {
  let ipfsService: IpfsService;
  let cacheService: IpfsDocumentCacheService;
  let mockRedis: Record<string, string>;
  let originalFetch: typeof global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DOCUMENT_CACHE_SECRET = 'test-secret-key-32b-length-secure-mock';

    mockRedis = {};
    originalFetch = global.fetch;

    const redisService: Partial<RedisService> = {
      setEx: jest.fn(async (key: string, _ttl: number, value: string) => {
        mockRedis[key] = value;
      }),
      get: jest.fn(async (key: string) => {
        return mockRedis[key] || null;
      }),
      sAdd: jest.fn(async () => {}),
      sMembers: jest.fn(async () => []),
    };

    cacheService = new IpfsDocumentCacheService(redisService as RedisService);
    const uploadPolicy = new IpfsUploadPolicy();
    ipfsService = new IpfsService(uploadPolicy, cacheService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it('serves a document directly from IPFS gateway when available and caches it', async () => {
    const hash = 'QmHealthyDoc123';
    const sampleData = { project: 'Verdant Forest', areaHa: 1200 };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleData,
      status: 200,
    } as Response);

    const result = await ipfsService.getContent(hash);
    expect(result).toEqual(sampleData);

    // Verify it was cached opportunistically
    const cached = await cacheService.getCachedDocument(hash);
    expect(cached).not.toBeNull();
  });

  it('simulates an IPFS gateway outage for a flagged audit document and confirms cache serves it', async () => {
    const hash = 'QmHistoricalAuditCert789';
    const historicalCertification = {
      certificateId: 'CERT-REDD-2024-99',
      standard: 'Gold Standard',
      verifier: 'SGS International Audits',
      status: 'Verified',
      historicalVintageYear: 2024,
    };

    // Pre-populate the cache as would occur during previous upload or audit intake
    await cacheService.cacheDocument(hash, historicalCertification, {
      filename: 'gold_standard_cert.json',
      mimetype: 'application/json',
      isAuditRelevant: true,
      disputeId: 'dispute-active-1',
    });

    // Simulate complete IPFS gateway outage (504 Gateway Timeout across all endpoints)
    global.fetch = jest.fn().mockImplementation(async (_url: string) => {
      return {
        ok: false,
        status: 504,
        statusText: 'Gateway Timeout - Pinata and IPFS peers unreachable',
      } as Response;
    });

    // Request the document during the outage
    const result = await ipfsService.getContent(hash);

    // Confirm that the document was served successfully from fallback cache
    expect(result).toBeDefined();
    expect(result.certificateId).toBe('CERT-REDD-2024-99');
    expect(result.standard).toBe('Gold Standard');
    expect(result._servedFromCache).toBe(true);
    expect(result._cacheTier).toBe('audit_relevant');
  });

  it('simulates IPFS gateway outage for an uncached document and returns structured unavailable exception', async () => {
    const hash = 'QmUncachedMissingDoc000';

    // Simulate gateway failure
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
    } as Response);

    // Expect IpfsUnavailableException with retry metadata rather than an unhandled crash
    await expect(ipfsService.getContent(hash)).rejects.toThrow(
      IpfsUnavailableException,
    );

    try {
      await ipfsService.getContent(hash);
    } catch (err: any) {
      expect(err).toBeInstanceOf(IpfsUnavailableException);
      expect(err.hash).toBe(hash);
      expect(err.retryAfterSeconds).toBe(30);
      expect(err.escalationPath).toContain(`/projects/documents/${hash}/escalate`);
    }
  });

  it('serves raw binary documents from fallback cache during gateway downtime', async () => {
    const hash = 'QmAuditPdfDocument555';
    const fakePdfBytes = Buffer.from('%PDF-1.4 Fake Certification Document');

    // Pre-cache binary document
    await cacheService.cacheDocument(hash, fakePdfBytes, {
      filename: 'audit-certification.pdf',
      mimetype: 'application/pdf',
      isAuditRelevant: true,
    });

    // Simulate gateway network error
    global.fetch = jest.fn().mockRejectedValue(new Error('Network error / connection refused'));

    const result = await ipfsService.retrieveDocument(hash);
    expect(result.servedFrom).toBe('cache');
    expect(result.mimetype).toBe('application/pdf');
    expect(result.filename).toBe('audit-certification.pdf');
    expect(result.tier).toBe('audit_relevant');
    expect(result.content).toBe(fakePdfBytes.toString('base64'));
  });
});
