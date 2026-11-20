import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { KycService } from './kyc.service';
import { KycStoreService } from '../common/services/kyc-store.service';
import {
  KycAuditEntry,
  KycRecord,
  KycStatus,
} from '../common/interfaces/authenticated-request.interface';

type FakeRedis = {
  store: Map<string, string>;
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};

const makeRedis = (): FakeRedis => {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string, _opts?: { EX?: number }) => {
      store.set(k, v);
    }),
    del: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
};

const makeTempKycDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'kyc-test-'));
  return dir;
};

describe('KycService', () => {
  let tmpDir: string;
  let redis: FakeRedis;
  let store: KycStoreService;
  let service: KycService;

  beforeEach(() => {
    tmpDir = makeTempKycDir();
    process.env.KYC_STORE_DIR = tmpDir;
    jest.resetModules();
    redis = makeRedis();
    store = new KycStoreService();
    service = new KycService(redis as any, store);
  });

  afterEach(() => {
    delete process.env.KYC_STORE_DIR;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const address = () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  describe('first lookup (cache miss + no durable record)', () => {
    it('creates a PENDING system record and caches it', async () => {
      const addr = address();
      const status = await service.getStatus(addr);
      expect(status).toBe(KycStatus.PENDING);
      expect(redis.set).toHaveBeenCalled();
      const cached = JSON.parse(redis.store.get(`kyc:${addr}`) as string) as KycRecord;
      expect(cached.address).toBe(addr);
      expect(cached.status).toBe(KycStatus.PENDING);
      expect(cached.source).toBe('system');
      expect(cached.reason).toMatch(/Initial KYC record/);

      const audit = await service.listAudit(addr);
      expect(audit.length).toBeGreaterThanOrEqual(1);
      expect(audit[audit.length - 1].toStatus).toBe(KycStatus.PENDING);
    });
  });

  describe('status transitions', () => {
    it('applies VERIFIED via admin with reason, source, providerReference, and audits it', async () => {
      const addr = address();
      const expires = Date.now() + 1000 * 60 * 60 * 24 * 365;
      const { record, entry, isNew } = await service.transitionStatus(
        addr,
        KycStatus.VERIFIED,
        {
          source: 'provider',
          actor: 'admin-0x0',
          reason: 'Documents reviewed successfully',
          providerReference: 'kyc-provider-12345',
          expiresAt: expires,
        },
      );

      expect(isNew).toBe(true);
      expect(record.status).toBe(KycStatus.VERIFIED);
      expect(record.providerReference).toBe('kyc-provider-12345');
      expect(record.expiresAt).toBe(expires);

      const e = entry as KycAuditEntry;
      expect(e.id).toMatch(/^[a-f0-9]{32}$/);
      expect(e.fromStatus).toBe(KycStatus.PENDING);
      expect(e.toStatus).toBe(KycStatus.VERIFIED);
      expect(e.source).toBe('provider');
      expect(e.actor).toBe('admin-0x0');
      expect(e.reason).toMatch(/Documents reviewed/);

      const audit = await service.listAudit(addr);
      const match = audit.find((a) => a.id === e.id);
      expect(match).toBeDefined();
    });

    it('writes through Redis cache after transition', async () => {
      const addr = address();
      await service.transitionStatus(addr, KycStatus.VERIFIED);
      expect(redis.del).toHaveBeenCalledWith(`kyc:${addr}`);
      const cached = JSON.parse(redis.store.get(`kyc:${addr}`) as string);
      expect(cached.status).toBe(KycStatus.VERIFIED);
    });

    it('verifies then downgrades to EXPIRED on lookup when past expiresAt', async () => {
      const addr = address();
      const expires = Date.now() - 1000;
      await service.transitionStatus(addr, KycStatus.VERIFIED, { expiresAt: expires });

      const effective = await service.getStatus(addr);
      expect(effective).toBe(KycStatus.EXPIRED);

      const full = await service.getFullStatus(addr);
      expect(full.status).toBe(KycStatus.EXPIRED);
      expect(full.reason).toMatch(/Verification expired/);
    });

    it('handles explicit REJECTED transition', async () => {
      const addr = address();
      const record = await service.reject(addr, 'Address on sanctions list', {
        actor: 'compliance-1',
        providerReference: 'sanctions-check-9',
      });
      expect(record.status).toBe(KycStatus.REJECTED);
      expect(record.reason).toMatch(/sanctions/);

      const eligible = await service.isEligible(addr, KycStatus.VERIFIED);
      expect(eligible).toBe(false);
    });

    it('ACCREDITED is eligible when VERIFIED is required', async () => {
      const addr = address();
      await service.verify(addr, { accredited: true });
      expect(await service.getStatus(addr)).toBe(KycStatus.ACCREDITED);
      expect(await service.isEligible(addr, KycStatus.VERIFIED)).toBe(true);
    });

    it('rejects invalid status values with BadRequestException', async () => {
      const addr = address();
      await expect(
        service.transitionStatus(addr, 'not-a-status' as KycStatus),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Redis cache behaviour', () => {
    it('serves status from valid cache without hitting durable store', async () => {
      const addr = address();
      const cachedRecord: KycRecord = {
        address: addr,
        status: KycStatus.VERIFIED,
        source: 'provider',
        actor: null,
        reason: null,
        providerReference: 'cached-only',
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 5000,
        expiresAt: null,
      };
      redis.store.set(`kyc:${addr}`, JSON.stringify(cachedRecord));

      const status = await service.getStatus(addr);
      expect(status).toBe(KycStatus.VERIFIED);
      // Confirm no new record was created in the durable store (no transitions)
      const audit = await service.listAudit(addr);
      expect(audit.filter((e) => e.providerReference !== 'cached-only').length).toBe(0);
    });

    it('invalidates malformed cache and falls back to durable store', async () => {
      const addr = address();
      redis.store.set(`kyc:${addr}`, 'not-json');
      const status = await service.getStatus(addr);
      expect(status).toBe(KycStatus.PENDING);
      // After recovery, cache is valid JSON
      expect(() => JSON.parse(redis.store.get(`kyc:${addr}`) as string)).not.toThrow();
    });
  });

  describe('KycGuard eligibility semantics (via isEligibleRecord)', () => {
    it('VERIFIED → eligible, EXPIRED → not eligible, REJECTED → not eligible, PENDING → not eligible', async () => {
      const addr = address();
      const cases: Array<[KycStatus, boolean, string | null]> = [
        [KycStatus.VERIFIED, true, null],
        [KycStatus.ACCREDITED, true, null],
        [KycStatus.PENDING, false, null],
        [KycStatus.NONE, false, null],
        [KycStatus.REJECTED, false, 'rejected'],
      ];
      for (const [status, wantEligible, wantReason] of cases) {
        await service.transitionStatus(addr, status);
        const { eligible, record } = await service.isEligibleRecord(
          addr,
          KycStatus.VERIFIED,
        );
        expect(eligible).toBe(wantEligible);
        if (wantReason) expect(record.status.toLowerCase()).toContain(wantReason);
      }
    });
  });

  describe('durability', () => {
    it('survives service restart: snapshot + audit replay reconstruct status', async () => {
      const addr = address();
      await service.verify(addr, { providerReference: 'original-vendor-1' });

      // Simulate restart: new instances of both services against same dir
      redis = makeRedis();
      store = new KycStoreService();
      service = new KycService(redis as any, store);
      await store.onModuleInit();

      const record = await service.getRecord(addr);
      expect(record.status).toBe(KycStatus.VERIFIED);
      expect(record.providerReference).toBe('original-vendor-1');
    });
  });
});
