import { Injectable, Logger } from '@nestjs/common';
import { BondsService } from '../bonds/bonds.service';
import { DexService } from '../marketplace/dex.service';
import { RedisService } from '../common/services/redis.service';
import { OrderStatus } from '../marketplace/interfaces/marketplace.interface';
import {
  PortfolioResponse,
  PortfolioBond,
  PortfolioListing,
  PortfolioPendingAction,
  PortfolioClaimableCredit,
  PortfolioRetiredCredit,
} from './portfolio.interface';

const PORTFOLIO_TTL_SECONDS = 30;

export interface PortfolioOptions {
  force?: boolean;
}

/**
 * Aggregates a wallet's complete position across the protocol: subscribed
 * bonds, open marketplace listings, claimable coupon credits, retired
 * credits, and pending actions (#116).
 *
 * Results are cached per-wallet for a short TTL and invalidated by the
 * mutation services whenever a subscribe/transfer/buy/claim/retire/list
 * operation changes that wallet's state, so the aggregate is never stale
 * after a user action.
 */
@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    private readonly bondsService: BondsService,
    private readonly dexService: DexService,
    private readonly redis: RedisService,
  ) {}

  async getPortfolio(address: string, opts: PortfolioOptions = {}): Promise<PortfolioResponse> {
    const cacheKey = `portfolio:${address}`;
    if (!opts.force) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as PortfolioResponse;
        } catch {
          // fall through and rebuild
        }
      }
    }

    const [held, listings, claimable, retired] = await Promise.all([
      this.bondsService.findHeldByAddress(address).catch(() => []),
      this.dexService.listOrders(undefined, undefined, 1, 1000).catch(() => ({ data: [] as any[] })),
      this.bondsService.getClaimableCredits(address).catch(() => []),
      this.bondsService.getRetiredCredits(address).catch(() => []),
    ]);

    const bondsHeld: PortfolioBond[] = held.map((b) => ({
      id: b.id,
      balance: b.balance,
      status: b.status,
      maturityStatus: b.maturityStatus,
      maturityDate: b.maturityDate,
    }));

    const openListings: PortfolioListing[] = (listings.data ?? [])
      .filter((o) => o.seller === address && (o.status === OrderStatus.Open || o.status === OrderStatus.PartiallyFilled))
      .map((o) => ({
        id: o.id,
        bondId: o.bondId,
        amount: o.amount,
        pricePerToken: o.pricePerToken,
        quoteAsset: o.quoteAsset,
        status: o.status,
        createdAt: o.createdAt,
      }));

    const claimableCredits: PortfolioClaimableCredit[] = claimable.filter(
      (c: PortfolioClaimableCredit) => BigInt(c.amount) > 0n,
    );
    const retiredCredits = retired as PortfolioRetiredCredit[];

    const pendingActions: PortfolioPendingAction[] = [];
    for (const c of claimableCredits) {
      pendingActions.push({ type: 'coupon_claim', bondId: c.bondId });
    }
    for (const b of bondsHeld) {
      if (b.maturityStatus === 'Active' && b.maturityDate * 1000 > Date.now()) {
        pendingActions.push({ type: 'maturity', bondId: b.id, detail: 'Bond approaching maturity' });
      }
    }
    for (const l of openListings) {
      pendingActions.push({ type: 'open_listing', bondId: l.bondId, detail: `Listing #${l.id}` });
    }

    const result: PortfolioResponse = {
      address,
      bondsHeld,
      openListings,
      claimableCredits,
      retiredCredits,
      pendingActions,
      generatedAt: new Date().toISOString(),
    };

    await this.redis.setEx(cacheKey, PORTFOLIO_TTL_SECONDS, JSON.stringify(result)).catch(() => undefined);
    return result;
  }
}
