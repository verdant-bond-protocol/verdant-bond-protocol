import {
  retrieveEvidenceWithFallback,
  isEvidenceAvailable,
  checkEvidenceAvailability,
  batchCheckAvailability,
  clearEvidenceCache,
  getCacheStats,
  IpfsFallbackConfig,
} from './fallback';
import { MockHttpClient } from '../oracle/test-helpers';

describe('IPFS Evidence Fallback and Availability (#627)', () => {
  const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  const PRIMARY_GATEWAY = 'https://primary.ipfs.gateway/ipfs/';
  const FALLBACK_1 = 'https://fallback1.ipfs.gateway/ipfs/';
  const FALLBACK_2 = 'https://fallback2.ipfs.gateway/ipfs/';

  const testConfig: Partial<IpfsFallbackConfig> = {
    primaryGateway: PRIMARY_GATEWAY,
    fallbackGateways: [FALLBACK_1, FALLBACK_2],
    maxRetries: 2,
    timeoutMs: 1000,
    enableCache: true,
    cacheTtlMs: 60_000,
  };

  beforeEach(() => {
    clearEvidenceCache();
  });

  describe('Normal Path', () => {
    it('retrieves evidence successfully from primary gateway', async () => {
      const mockHttp = new MockHttpClient([
        { status: 200, data: { certification: 'verified', credits: 5000 } },
      ]);

      const result = await retrieveEvidenceWithFallback(CID, testConfig, mockHttp);

      expect(result.success).toBe(true);
      expect(result.gatewayUsed).toBe(PRIMARY_GATEWAY);
      expect(result.fromCache).toBe(false);
      expect(result.attemptsCount).toBe(1);
      expect(result.content).toEqual({ certification: 'verified', credits: 5000 });
      expect(mockHttp.calls).toHaveLength(1);
      expect(mockHttp.calls[0].url).toBe(`${PRIMARY_GATEWAY}${CID}`);
    });

    it('confirms evidence availability on primary gateway', async () => {
      const mockHttp = new MockHttpClient([{ status: 200, data: 'OK' }]);

      const result = await checkEvidenceAvailability(CID, testConfig, mockHttp);

      expect(result.available).toBe(true);
      expect(result.gatewayUsed).toBe(PRIMARY_GATEWAY);
      expect(result.attempts).toBe(1);
      expect(result.fromCache).toBe(false);
    });

    it('serves subsequent requests from cache in O(1) time without network call', async () => {
      const mockHttp = new MockHttpClient([
        { status: 200, data: { cached: true } },
      ]);

      const first = await retrieveEvidenceWithFallback(CID, testConfig, mockHttp);
      expect(first.fromCache).toBe(false);
      expect(getCacheStats().size).toBe(1);

      // Second retrieval hits cache
      const second = await retrieveEvidenceWithFallback(CID, testConfig, mockHttp);
      expect(second.success).toBe(true);
      expect(second.fromCache).toBe(true);
      expect(second.attemptsCount).toBe(0);
      expect(second.content).toEqual({ cached: true });

      // No second HTTP request made
      expect(mockHttp.calls).toHaveLength(1);

      // Availability also hits cache
      const avail = await checkEvidenceAvailability(CID, testConfig, mockHttp);
      expect(avail.available).toBe(true);
      expect(avail.fromCache).toBe(true);
      expect(avail.attempts).toBe(0);
    });
  });

  describe('Fallback Path', () => {
    it('falls back to secondary gateway when primary fails with server error', async () => {
      const mockHttp = new MockHttpClient([
        // Primary gateway fails twice (maxRetries = 2)
        new Error('500 Internal Server Error'),
        new Error('500 Internal Server Error'),
        // Fallback 1 succeeds
        { status: 200, data: { evidence: 'restored' } },
      ]);

      const result = await retrieveEvidenceWithFallback(CID, testConfig, mockHttp);

      expect(result.success).toBe(true);
      expect(result.gatewayUsed).toBe(FALLBACK_1);
      expect(result.attemptsCount).toBe(3); // 2 primary + 1 fallback
      expect(result.content).toEqual({ evidence: 'restored' });
      expect(mockHttp.calls[0].url).toBe(`${PRIMARY_GATEWAY}${CID}`);
      expect(mockHttp.calls[2].url).toBe(`${FALLBACK_1}${CID}`);
    });

    it('falls back across multiple gateways until an available one is found', async () => {
      const mockHttp = new MockHttpClient([
        // Primary fails
        new Error('Primary gateway timeout'),
        // Fallback 1 fails
        new Error('Fallback 1 502 Bad Gateway'),
        // Fallback 2 succeeds
        { status: 200, data: 'OK' },
      ]);

      const result = await checkEvidenceAvailability(
        CID,
        { ...testConfig, maxRetries: 1 },
        mockHttp,
      );

      expect(result.available).toBe(true);
      expect(result.gatewayUsed).toBe(FALLBACK_2);
      expect(result.attempts).toBe(3);
    });
  });

  describe('Failure Path', () => {
    it('returns failure when all primary and fallback gateways are exhausted', async () => {
      const mockHttp = new MockHttpClient([
        new Error('Primary down'),
        new Error('Primary retry down'),
        new Error('Fallback 1 down'),
        new Error('Fallback 1 retry down'),
        new Error('Fallback 2 down'),
        new Error('Fallback 2 retry down'),
      ]);

      const result = await retrieveEvidenceWithFallback(CID, testConfig, mockHttp);

      expect(result.success).toBe(false);
      expect(result.gatewayUsed).toBeUndefined();
      expect(result.attemptsCount).toBe(6);
      expect(result.error).toContain('Failed to retrieve evidence');
    });

    it('reports unavailable when no gateway responds with 2xx status', async () => {
      const mockHttp = new MockHttpClient([
        { status: 404, data: 'Not Found' },
        { status: 404, data: 'Not Found' },
        { status: 404, data: 'Not Found' },
      ]);

      const result = await checkEvidenceAvailability(CID, testConfig, mockHttp);

      expect(result.available).toBe(false);
      expect(result.gatewayUsed).toBeUndefined();
      expect(result.attempts).toBe(3);
      expect(result.error).toContain('not retrievable after 3 attempts');
    });
  });

  describe('Retry & Batch Operations', () => {
    it('retries transient failures on the same gateway before falling back', async () => {
      const mockHttp = new MockHttpClient([
        new Error('429 Rate limited'),
        { status: 200, data: { success: true } },
      ]);

      const result = await retrieveEvidenceWithFallback(CID, testConfig, mockHttp);

      expect(result.success).toBe(true);
      expect(result.gatewayUsed).toBe(PRIMARY_GATEWAY);
      expect(result.attemptsCount).toBe(2);
      expect(mockHttp.calls[0].url).toBe(`${PRIMARY_GATEWAY}${CID}`);
      expect(mockHttp.calls[1].url).toBe(`${PRIMARY_GATEWAY}${CID}`);
    });

    it('batchCheckAvailability processes multiple CIDs with concurrent chunking', async () => {
      const cids = [
        'QmCID111111111111111111111111111111111111111111',
        'QmCID222222222222222222222222222222222222222222',
        'QmCID333333333333333333333333333333333333333333',
      ];

      const mockHttp = new MockHttpClient([
        { status: 200, data: 'OK' }, // CID 1 primary
        new Error('Fail'),           // CID 2 primary fail
        { status: 200, data: 'OK' }, // CID 2 fallback 1 succeed
        new Error('Fail'),           // CID 3 primary fail
        new Error('Fail'),           // CID 3 fallback 1 fail
        new Error('Fail'),           // CID 3 fallback 2 fail
      ]);

      const results = await batchCheckAvailability(
        cids,
        { ...testConfig, maxRetries: 1 },
        mockHttp,
      );

      expect(results.get(cids[0])).toBe(true);
      expect(results.get(cids[1])).toBe(true);
      expect(results.get(cids[2])).toBe(false);
    });
  });
});

