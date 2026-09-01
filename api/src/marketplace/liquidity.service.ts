import { Injectable } from '@nestjs/common';
import { DexService } from './dex.service';
import {
  PriceFeedResponse,
  PriceLevel,
  SlippageResponse,
  OrderStatus,
  FillabilityStatus,
} from './interfaces/marketplace.interface';
import { RedisService } from '../common/services/redis.service';
import { toBigIntString } from '../common/utils';

@Injectable()
export class LiquidityService {
  constructor(
    private readonly dexService: DexService,
    private readonly redis: RedisService,
  ) {}

  async getPriceFeed(bondId?: number): Promise<PriceFeedResponse[]> {
    const cacheKey = `pricefeed:${bondId || 'all'}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const ordersResult = await this.dexService.listOrders(bondId, 'Open', 1, 100);
    const openOrders = ordersResult.data;

    const grouped = new Map<number, { prices: bigint[]; amounts: bigint[]; totalVolume: bigint }>();

    for (const order of openOrders) {
      if (order.status !== OrderStatus.Open) continue;

      const group = grouped.get(order.bondId) || { prices: [], amounts: [], totalVolume: BigInt(0) };
      group.prices.push(BigInt(order.pricePerToken));
      group.amounts.push(BigInt(order.amount));
      group.totalVolume += BigInt(order.amount) * BigInt(order.pricePerToken);
      grouped.set(order.bondId, group);
    }

    const feeds: PriceFeedResponse[] = [];

    for (const [id, group] of grouped) {
      const bestPrice = group.prices.reduce((a, b) => a < b ? a : b, BigInt(0));
      const sumPrices = group.prices.reduce((a, b) => a + b, BigInt(0));
      const averagePrice = group.prices.length > 0 ? sumPrices / BigInt(group.prices.length) : BigInt(0);

      feeds.push({
        bondId: id,
        bestPrice: toBigIntString(bestPrice),
        averagePrice: toBigIntString(averagePrice),
        totalOrders: group.prices.length,
        totalVolume: toBigIntString(group.totalVolume),
      });
    }

    await this.redis.cacheSet(cacheKey, 30, JSON.stringify(feeds), ['prices']);
    return feeds;
  }

  async getBestPrice(bondId: number, _side: 'buy' | 'sell'): Promise<PriceLevel> {
    const ordersResult = await this.dexService.listOrders(bondId, 'Open', 1, 100);
    const openOrders = ordersResult.data;

    const sorted = [...openOrders].sort((a, b) => {
      const priceA = BigInt(a.pricePerToken);
      const priceB = BigInt(b.pricePerToken);
      return priceA < priceB ? -1 : priceA > priceB ? 1 : 0;
    });

    if (sorted.length === 0) {
      return { price: '0', amount: '0', total: '0' };
    }

    const best = sorted[0];
    const total = BigInt(best.pricePerToken) * BigInt(best.amount);

    return {
      price: best.pricePerToken,
      amount: best.amount,
      total: toBigIntString(total),
    };
  }

  async calculateSlippage(bondId: number, amount: number): Promise<SlippageResponse> {
    const ordersResult = await this.dexService.listOrders(bondId, 'Open', 1, 100);
    const openOrders = ordersResult.data;

    const sorted = [...openOrders].sort((a, b) => {
      const priceA = BigInt(a.pricePerToken);
      const priceB = BigInt(b.pricePerToken);
      return priceA < priceB ? -1 : priceA > priceB ? 1 : 0;
    });

    let remaining = BigInt(amount);
    let totalCost = BigInt(0);
    let totalAmount = BigInt(0);

    for (const order of sorted) {
      if (remaining <= BigInt(0)) break;
      const orderAmount = BigInt(order.amount);
      const take = remaining < orderAmount ? remaining : orderAmount;
      totalCost += take * BigInt(order.pricePerToken);
      totalAmount += take;
      remaining -= take;
    }

    const fillableAmount = BigInt(amount) - remaining;
    const unfilledAmount = remaining;
    
    let fillabilityStatus: FillabilityStatus;
    if (unfilledAmount === BigInt(0)) {
      fillabilityStatus = 'fully_fillable';
    } else if (fillableAmount > BigInt(0)) {
      fillabilityStatus = 'partially_fillable';
    } else {
      fillabilityStatus = 'unfillable';
    }

    const averagePrice = totalAmount > BigInt(0) ? totalCost / totalAmount : BigInt(0);
    const idealCost = BigInt(amount) > BigInt(0) && sorted.length > 0 
      ? BigInt(amount) * BigInt(sorted[0].pricePerToken) 
      : BigInt(0);
    const slippagePercent = idealCost > BigInt(0) 
      ? Number(((totalCost - idealCost) * BigInt(100)) / idealCost)
      : 0;

    return {
      bondId,
      requestedAmount: toBigIntString(amount),
      fillableAmount: toBigIntString(fillableAmount),
      unfilledAmount: toBigIntString(unfilledAmount),
      averagePrice: toBigIntString(averagePrice),
      estimatedTotal: toBigIntString(totalCost),
      slippagePercent: Math.max(0, slippagePercent),
      fillabilityStatus,
    };
  }
}
