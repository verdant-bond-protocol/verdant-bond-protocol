import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ForbiddenException } from '@nestjs/common';
import { InvestorEligibilityCacheService } from './investor-eligibility-cache.service';
import { KycService } from './kyc.service';
import { KycStoreService } from '../common/services/kyc-store.service';
import { KycStatus } from '../common/interfaces/authenticated-request.interface';

const ELIGIBLE = { eligible: true };
const INELIGIBLE = { eligible: false, code: 'KYC_REQUIRED' };

describe('InvestorEligibilityCacheService (#438)', () => {
  let cache: InvestorEligibilityCacheService;
  let clock: number;

  beforeEach(() => {
    clock = 1_000_000;
    cache = new InvestorEligibilityCacheService();
    cache.now = () => clock;
  });

  describe('normal path', () => {
    it('serves cached decisions until the TTL elapses', () => {
      cache.set('GA', 'bond-1', ELIGIBLE, KycStatus.VERIFIED, cache.generationOf('GA'));
      expect(cache.get('GA', 'bond-1')).toEqual(ELIGIBLE);
      clock += cache.ttlMs - 1;
      expect(cache.get('GA', 'bond-1')).toEqual(ELIGIBLE);
      clock += 1;
      expect(cache.get('GA', 'bond-1')).toBeUndefined();
    });

    it('getOrCompute computes once and then hits the cache', async () => {
      const compute = jest.fn(async () => ({ decision: ELIGIBLE, kycStatus: KycStatus.VERIFIED }));
      await cache.getOrCompute('GA', 'bond-1', compute);
      await cache.getOrCompute('GA', 'bond-1', compute);
      expect(compute).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidation on KYC change', () => {
    it('drops every bond entry of the investor, and only that investor', () => {
      const g = cache.generationOf('GA');
      cache.set('GA', 'bond-1', ELIGIBLE, KycStatus.VERIFIED, g);
      cache.set('GA', 'bond-2', ELIGIBLE, KycStatus.VERIFIED, g);
      cache.set('GB', 'bond-1', ELIGIBLE, KycStatus.VERIFIED, cache.generationOf('GB'));

      expect(cache.onKycStatusChanged('GA', KycStatus.VERIFIED, KycStatus.REJECTED)).toBe(2);
      expect(cache.get('GA', 'bond-1')).toBeUndefined();
      expect(cache.get('GA', 'bond-2')).toBeUndefined();
      expect(cache.get('GB', 'bond-1')).toEqual(ELIGIBLE);

      expect(cache.listInvalidations('GA')).toEqual([
        {
          investor: 'GA',
          fromStatus: KycStatus.VERIFIED,
          toStatus: KycStatus.REJECTED,
          reason: `kyc:${KycStatus.VERIFIED}->${KycStatus.REJECTED}`,
          entriesDropped: 2,
          at: clock,
        },
      ]);
    });

    it('discards a stale write from a lookup that raced an invalidation', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const pending = cache.getOrCompute('GA', 'bond-1', async () => {
        await gate;
        return { decision: ELIGIBLE, kycStatus: KycStatus.VERIFIED };
      });
      // KYC is revoked while the old evaluation is still in flight.
      cache.onKycStatusChanged('GA', KycStatus.VERIFIED, KycStatus.REJECTED);
      release();
      await pending;
      expect(cache.get('GA', 'bond-1')).toBeUndefined();
      expect(cache.size()).toBe(0);
    });

    it('rejects a direct write with an old generation', () => {
      const g = cache.generationOf('GA');
      cache.invalidateInvestor('GA', 'test');
      expect(cache.set('GA', 'bond-1', ELIGIBLE, KycStatus.VERIFIED, g)).toBe(false);
      expect(cache.set('GA', 'bond-1', INELIGIBLE, KycStatus.REJECTED, cache.generationOf('GA'))).toBe(true);
      expect(cache.get('GA', 'bond-1')).toEqual(INELIGIBLE);
    });
  });

  describe('failure and retry paths', () => {
    it('caches nothing when the evaluation fails, so the next call retries', async () => {
      const compute = jest
        .fn()
        .mockRejectedValueOnce(new Error('rules engine down'))
        .mockResolvedValueOnce({ decision: ELIGIBLE, kycStatus: KycStatus.VERIFIED });
      await expect(cache.getOrCompute('GA', 'bond-1', compute)).rejects.toThrow('rules engine down');
      expect(cache.size()).toBe(0);
      await expect(cache.getOrCompute('GA', 'bond-1', compute)).resolves.toEqual(ELIGIBLE);
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it('repeated invalidations are safe', () => {
      cache.invalidateInvestor('GA', 'a');
      expect(cache.invalidateInvestor('GA', 'b')).toBe(0);
    });
  });

  describe('authorization', () => {
    it('only admins can flush the whole cache', () => {
      cache.set('GA', 'bond-1', ELIGIBLE, KycStatus.VERIFIED, 0);
      cache.set('GB', 'bond-1', ELIGIBLE, KycStatus.VERIFIED, 0);
      expect(() => cache.flushAll({ isAdmin: false, address: 'GX' })).toThrow(ForbiddenException);
      expect(cache.size()).toBe(2);
      expect(cache.flushAll({ isAdmin: true, address: 'GADMIN' })).toBe(2);
      expect(cache.size()).toBe(0);
    });
  });

  describe('KycService integration', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'kyc-elig-'));
      process.env.KYC_STORE_DIR = tmpDir;
    });

    afterEach(() => {
      delete process.env.KYC_STORE_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    });

    const fakeRedis = () => {
      const store = new Map<string, string>();
      return {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        set: jest.fn(async (k: string, v: string) => {
          store.set(k, v);
        }),
        del: jest.fn(async (k: string) => {
          store.delete(k);
        }),
      };
    };

    it('invalidates cached eligibility when KYC status transitions', async () => {
      const kyc = new KycService(fakeRedis() as any, new KycStoreService(), cache);
      await kyc.verify('GA');
      cache.set('GA', 'bond-1', ELIGIBLE, KycStatus.VERIFIED, cache.generationOf('GA'));
      expect(cache.get('GA', 'bond-1')).toEqual(ELIGIBLE);

      await kyc.reject('GA', 'sanctions hit');
      expect(cache.get('GA', 'bond-1')).toBeUndefined();
      const last = cache.listInvalidations('GA').pop();
      expect(last?.fromStatus).toBe(KycStatus.VERIFIED);
      expect(last?.toStatus).toBe(KycStatus.REJECTED);
    });

    it('keeps working without the cache provider', async () => {
      const kyc = new KycService(fakeRedis() as any, new KycStoreService());
      await expect(kyc.verify('GA')).resolves.toMatchObject({ status: KycStatus.VERIFIED });
    });
  });
});
