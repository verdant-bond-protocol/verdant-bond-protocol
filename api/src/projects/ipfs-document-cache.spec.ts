import {
  IpfsDocumentCacheService,
  ROUTINE_RETENTION_SECONDS,
  AUDIT_RETENTION_SECONDS,
} from './ipfs-document-cache.service';
import { RedisService } from '../common/services/redis.service';

describe('IpfsDocumentCacheService', () => {
  let cacheService: IpfsDocumentCacheService;
  let mockRedis: Record<string, string>;
  let mockSets: Record<string, Set<string>>;
  let redisService: Partial<RedisService>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DOCUMENT_CACHE_SECRET = 'test-secret-key-32b-length-secure-mock';
    delete process.env.DOCUMENT_CACHE_ENCRYPTION;

    mockRedis = {};
    mockSets = {};

    redisService = {
      setEx: jest.fn(async (key: string, seconds: number, value: string) => {
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
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Configuration & Fail-Closed Security', () => {
    it('fails closed and throws an error on startup when encryption is enabled but secret is missing', () => {
      delete process.env.DOCUMENT_CACHE_SECRET;
      delete process.env.JWT_SECRET;
      delete process.env.DOCUMENT_CACHE_ENCRYPTION;

      expect(() => {
        new IpfsDocumentCacheService(redisService as RedisService);
      }).toThrow(
        /DOCUMENT_CACHE_SECRET.*is required when IPFS document cache encryption is enabled/,
      );
    });

    it('initializes successfully when encryption is disabled explicitly without a secret', () => {
      delete process.env.DOCUMENT_CACHE_SECRET;
      delete process.env.JWT_SECRET;
      process.env.DOCUMENT_CACHE_ENCRYPTION = 'false';

      expect(() => {
        new IpfsDocumentCacheService(redisService as RedisService);
      }).not.toThrow();
    });
  });

  describe('Tiered Retention Policy', () => {
    it('applies routine retention period (30 days) to routine documents', async () => {
      const hash = 'QmRoutineDoc123';
      const payload = { document: 'general report', notes: 'draft' };

      const record = await cacheService.cacheDocument(hash, payload, {
        isAuditRelevant: false,
      });

      expect(record.tier).toBe('routine');
      expect(record.isAuditRelevant).toBe(false);
      expect(redisService.setEx).toHaveBeenCalledWith(
        `ipfs:cache:doc:${hash}`,
        ROUTINE_RETENTION_SECONDS,
        expect.any(String),
      );
    });

    it('applies long-term retention period (10 years) to audit-relevant documents', async () => {
      const hash = 'QmAuditCertification456';
      const payload = {
        standard: 'Verra VCS',
        serialNumber: 'VCS-2026-0914-112',
        creditsVerified: 50000,
      };

      const record = await cacheService.cacheDocument(hash, payload, {
        isAuditRelevant: true,
        disputeId: 'disp-789',
      });

      expect(record.tier).toBe('audit_relevant');
      expect(record.isAuditRelevant).toBe(true);
      expect(record.disputeId).toBe('disp-789');
      expect(redisService.setEx).toHaveBeenCalledWith(
        `ipfs:cache:doc:${hash}`,
        AUDIT_RETENTION_SECONDS,
        expect.any(String),
      );
      expect(redisService.sAdd).toHaveBeenCalledWith(
        'ipfs:cache:audit_relevant_hashes',
        hash,
      );
    });
  });

  describe('Encryption & Cryptographic Integrity', () => {
    it('encrypts cached documents using AES-256-GCM and verifies SHA-256 on decryption', async () => {
      const hash = 'QmConfidentialAuditDoc';
      const rawText = 'Sensitive historical verification report content';

      await cacheService.cacheDocument(hash, rawText, {
        filename: 'audit.txt',
        mimetype: 'text/plain',
        isAuditRelevant: true,
      });

      // Verify that Redis stored an encrypted string, not plain text
      const storedJson = mockRedis[`ipfs:cache:doc:${hash}`];
      expect(storedJson).toBeDefined();
      expect(storedJson).not.toContain(rawText);

      // Decrypt and verify integrity
      const retrieved = await cacheService.getCachedDocument(hash);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.content).toBe(rawText);
      expect(retrieved?.record.checksum).toBeDefined();
    });

    it('rejects cached document if payload has been tampered with', async () => {
      const hash = 'QmTamperedDoc';
      const rawText = 'Original untampered content';

      await cacheService.cacheDocument(hash, rawText);

      // Tamper with the checksum in Redis
      const stored = JSON.parse(mockRedis[`ipfs:cache:doc:${hash}`]);
      stored.checksum = 'deadbeef00000000000000000000000000000000000000000000000000000000';
      mockRedis[`ipfs:cache:doc:${hash}`] = JSON.stringify(stored);

      const retrieved = await cacheService.getCachedDocument(hash);
      expect(retrieved).toBeNull();
    });
  });

  describe('Audit Promotion', () => {
    it('promotes an existing routine document to the audit-relevant long retention tier', async () => {
      const hash = 'QmDocToPromote';
      await cacheService.cacheDocument(hash, 'Routine content', {
        isAuditRelevant: false,
      });

      const updated = await cacheService.flagAsAuditRelevant(hash, 'dispute-001');
      expect(updated).not.toBeNull();
      expect(updated?.tier).toBe('audit_relevant');
      expect(updated?.disputeId).toBe('dispute-001');

      expect(redisService.setEx).toHaveBeenLastCalledWith(
        `ipfs:cache:doc:${hash}`,
        AUDIT_RETENTION_SECONDS,
        expect.any(String),
      );
    });
  });
});
