import { Injectable, BadRequestException, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { RedisService } from '../common/services/redis.service';
import { KycStoreService } from '../common/services/kyc-store.service';
import { InvestorEligibilityCacheService } from './investor-eligibility-cache.service';
import {
  KycAuditEntry,
  KycRecord,
  KycStatus,
  KycStatusSource,
} from '../common/interfaces/authenticated-request.interface';

const CACHE_KEY = (address: string) => `kyc:${address}`;
const CACHE_TTL_SECONDS = 60;

const STATUS_ORDER: KycStatus[] = [
  KycStatus.NONE,
  KycStatus.PENDING,
  KycStatus.REJECTED,
  KycStatus.EXPIRED,
  KycStatus.VERIFIED,
  KycStatus.ACCREDITED,
];

const ELIGIBLE_ELIGIBILITY_SET = new Set<KycStatus>([
  KycStatus.VERIFIED,
  KycStatus.ACCREDITED,
]);

@Injectable()
export class KycService {
  constructor(
    private readonly redis: RedisService,
    private readonly store: KycStoreService,
    @Optional() private readonly eligibilityCache?: InvestorEligibilityCacheService,
  ) {}

  private async writeThroughCache(record: KycRecord): Promise<void> {
    await this.redis.set(
      CACHE_KEY(record.address),
      JSON.stringify(record),
      { EX: CACHE_TTL_SECONDS },
    );
  }

  private async invalidateCache(address: string): Promise<void> {
    await this.redis.del(CACHE_KEY(address));
  }

  private isExpired(record: KycRecord): boolean {
    return record.expiresAt != null && record.expiresAt <= Date.now();
  }

  private resolveEffectiveStatus(record: KycRecord): KycStatus {
    if (this.isExpired(record) && ELIGIBLE_ELIGIBILITY_SET.has(record.status)) {
      return KycStatus.EXPIRED;
    }
    return record.status;
  }

  async getRecord(address: string): Promise<KycRecord> {
    const cacheHit = await this.redis.get(CACHE_KEY(address));
    if (cacheHit) {
      try {
        const parsed = JSON.parse(cacheHit) as KycRecord;
        return parsed;
      } catch {
        await this.invalidateCache(address);
      }
    }

    const fromStore = await this.store.get(address);
    if (fromStore) {
      await this.writeThroughCache(fromStore);
      return fromStore;
    }

    const { record: created } = await this.transitionStatus(address, KycStatus.PENDING, {
      source: 'system',
      reason: 'Initial KYC record created on first lookup',
    });
    return created;
  }

  async getStatus(address: string): Promise<KycStatus> {
    const record = await this.getRecord(address);
    return this.resolveEffectiveStatus(record);
  }

  async getFullStatus(address: string): Promise<KycRecord> {
    const record = await this.getRecord(address);
    const effective = this.resolveEffectiveStatus(record);
    if (effective !== record.status) {
      const { record: updated } = await this.transitionStatus(
        address,
        KycStatus.EXPIRED,
        {
          source: 'system',
          reason: `Verification expired at ${new Date(record.expiresAt!).toISOString()}`,
          expiresAt: record.expiresAt,
        },
      );
      return updated;
    }
    return record;
  }

  async listAudit(address: string, limit = 100): Promise<KycAuditEntry[]> {
    return this.store.listAudit(address, limit);
  }

  async listAll(): Promise<KycRecord[]> {
    return (await this.store.list()).map((r) => ({
      ...r,
      status: this.resolveEffectiveStatus(r),
    }));
  }

  async transitionStatus(
    address: string,
    toStatus: KycStatus,
    opts: {
      source?: KycStatusSource;
      actor?: string | null;
      reason?: string | null;
      providerReference?: string | null;
      expiresAt?: number | null;
    } = {},
  ): Promise<{ record: KycRecord; entry: KycAuditEntry; isNew: boolean }> {
    if (!Object.values(KycStatus).includes(toStatus)) {
      throw new BadRequestException(`Invalid KYC status: ${toStatus}`);
    }

    const source = opts.source ?? 'admin';
    const result = await this.store.applyTransition({
      address,
      toStatus,
      source,
      actor: opts.actor ?? null,
      reason: opts.reason ?? null,
      providerReference: opts.providerReference ?? null,
      expiresAt: opts.expiresAt ?? null,
    });

    if (result.isNew || (result.entry as KycAuditEntry).id) {
      await this.invalidateCache(address);
      await this.writeThroughCache(result.record);
      this.eligibilityCache?.onKycStatusChanged(
        address,
        (result.entry as KycAuditEntry).fromStatus ?? null,
        result.record.status,
      );
    }
    return result;
  }

  async updateStatus(address: string, status: KycStatus): Promise<void> {
    await this.transitionStatus(address, status, { source: 'admin' });
  }

  async reject(
    address: string,
    reason: string,
    opts: { actor?: string | null; providerReference?: string | null } = {},
  ): Promise<KycRecord> {
    const { record } = await this.transitionStatus(address, KycStatus.REJECTED, {
      source: 'admin',
      actor: opts.actor ?? null,
      reason,
      providerReference: opts.providerReference ?? null,
    });
    return record;
  }

  async verify(
    address: string,
    opts: {
      actor?: string | null;
      reason?: string | null;
      providerReference?: string | null;
      expiresAt?: number | null;
      accredited?: boolean;
    } = {},
  ): Promise<KycRecord> {
    const toStatus = opts.accredited ? KycStatus.ACCREDITED : KycStatus.VERIFIED;
    const { record } = await this.transitionStatus(address, toStatus, {
      source: 'provider',
      actor: opts.actor ?? null,
      reason: opts.reason ?? 'KYC verification completed',
      providerReference: opts.providerReference ?? null,
      expiresAt: opts.expiresAt ?? null,
    });
    return record;
  }

  async isEligible(address: string, requiredStatus: KycStatus): Promise<boolean> {
    const actual = await this.getStatus(address);
    return this.compareStatus(actual, requiredStatus);
  }

  async isEligibleRecord(address: string, requiredStatus: KycStatus): Promise<{ eligible: boolean; record: KycRecord }> {
    const record = await this.getFullStatus(address);
    const eligible = this.compareStatus(record.status, requiredStatus);
    return { eligible, record };
  }

  private compareStatus(actual: KycStatus, required: KycStatus): boolean {
    return STATUS_ORDER.indexOf(actual) >= STATUS_ORDER.indexOf(required);
  }
}
