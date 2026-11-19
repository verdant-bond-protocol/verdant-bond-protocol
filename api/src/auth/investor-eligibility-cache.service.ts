import { ForbiddenException, Injectable } from '@nestjs/common';
import { KycStatus } from '../common/interfaces/authenticated-request.interface';

/**
 * Investor eligibility cache with invalidation on KYC status changes (#438).
 *
 * Eligibility decisions (investor x bond) are cached for a short TTL. Every
 * KYC transition bumps the investor's generation and drops their entries, so
 * a revoked or expired investor can never be served a stale "eligible".
 *
 * A lookup that started before an invalidation cannot repopulate the cache
 * with its (now stale) result: writes carry the generation observed when the
 * lookup began and are discarded if it has moved on.
 * See docs/eligibility-cache.md.
 */

export interface EligibilityDecision {
  eligible: boolean;
  code?: string;
  reason?: string;
}

interface CacheEntry {
  decision: EligibilityDecision;
  generation: number;
  kycStatus: KycStatus;
  expiresAt: number;
}

export interface EligibilityInvalidation {
  investor: string;
  fromStatus: KycStatus | null;
  toStatus: KycStatus | null;
  reason: string;
  entriesDropped: number;
  at: number;
}

export const ELIGIBILITY_CACHE_TTL_MS = 30_000;
export const MAX_INVALIDATION_LOG = 1_000;

@Injectable()
export class InvestorEligibilityCacheService {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly generations = new Map<string, number>();
  private readonly invalidations: EligibilityInvalidation[] = [];

  ttlMs = ELIGIBILITY_CACHE_TTL_MS;
  now: () => number = () => Date.now();

  private key(investor: string, bondId: string): string {
    return `${investor}|${bondId}`;
  }

  generationOf(investor: string): number {
    return this.generations.get(investor) ?? 0;
  }

  get(investor: string, bondId: string): EligibilityDecision | undefined {
    const key = this.key(investor, bondId);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.generation !== this.generationOf(investor) || entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return { ...entry.decision };
  }

  /**
   * Stores a decision computed from `kycStatus`. `generation` must be the
   * value of `generationOf(investor)` read before the decision was computed.
   * Returns false when the write was discarded as stale.
   */
  set(
    investor: string,
    bondId: string,
    decision: EligibilityDecision,
    kycStatus: KycStatus,
    generation: number,
  ): boolean {
    if (generation !== this.generationOf(investor)) {
      return false;
    }
    this.entries.set(this.key(investor, bondId), {
      decision: { ...decision },
      generation,
      kycStatus,
      expiresAt: this.now() + this.ttlMs,
    });
    return true;
  }

  /**
   * Read-through helper. A failing `compute` caches nothing, so the next call
   * retries the evaluation.
   */
  async getOrCompute(
    investor: string,
    bondId: string,
    compute: () => Promise<{ decision: EligibilityDecision; kycStatus: KycStatus }>,
  ): Promise<EligibilityDecision> {
    const cached = this.get(investor, bondId);
    if (cached) return cached;
    const generation = this.generationOf(investor);
    const { decision, kycStatus } = await compute();
    this.set(investor, bondId, decision, kycStatus, generation);
    return { ...decision };
  }

  /** Called by KycService after every successful status transition. */
  onKycStatusChanged(investor: string, fromStatus: KycStatus | null, toStatus: KycStatus): number {
    return this.invalidateInvestor(investor, `kyc:${fromStatus ?? 'none'}->${toStatus}`, fromStatus, toStatus);
  }

  invalidateInvestor(
    investor: string,
    reason: string,
    fromStatus: KycStatus | null = null,
    toStatus: KycStatus | null = null,
  ): number {
    this.generations.set(investor, this.generationOf(investor) + 1);
    const prefix = `${investor}|`;
    let dropped = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        dropped += 1;
      }
    }
    this.invalidations.push({ investor, fromStatus, toStatus, reason, entriesDropped: dropped, at: this.now() });
    if (this.invalidations.length > MAX_INVALIDATION_LOG) {
      this.invalidations.splice(0, this.invalidations.length - MAX_INVALIDATION_LOG);
    }
    return dropped;
  }

  /** Operator recovery: drop every cached decision. Admin only. */
  flushAll(actor: { isAdmin: boolean; address: string }): number {
    if (!actor.isAdmin) {
      throw new ForbiddenException({
        code: 'ELIGIBILITY_FLUSH_FORBIDDEN',
        message: 'Only admins can flush the eligibility cache',
      });
    }
    const investors = new Set<string>();
    for (const key of this.entries.keys()) {
      investors.add(key.slice(0, key.indexOf('|')));
    }
    let dropped = 0;
    for (const investor of investors) {
      dropped += this.invalidateInvestor(investor, `admin-flush:${actor.address}`);
    }
    return dropped;
  }

  listInvalidations(investor?: string): EligibilityInvalidation[] {
    return this.invalidations.filter((i) => !investor || i.investor === investor).map((i) => ({ ...i }));
  }

  size(): number {
    return this.entries.size;
  }
}
