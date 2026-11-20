import { BadRequestException, Injectable } from '@nestjs/common';
import { DexService } from './dex.service';
import {
  PriceFeedResponse,
  PriceLevel,
  SlippageResponse,
  OrderStatus,
  FillabilityStatus,
  QuoteAsset,
} from './interfaces/marketplace.interface';
import { RedisService } from '../common/services/redis.service';
import { toBigIntString } from '../common/utils';

@Injectable()
export class LiquidityService {
  constructor(
    private readonly dexService: DexService,
    private readonly redis: RedisService,
  ) {}

  async getPriceFeed(bondId?: number, quoteAsset?: QuoteAsset): Promise<PriceFeedResponse[]> {
    const cacheKey = `pricefeed:${bondId || 'all'}:${quoteAsset || 'all'}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const ordersResult = await this.dexService.listOrders(bondId, 'Open', 1, 100);
    const openOrders = ordersResult.data;

    const grouped = new Map<
      string,
      { bondId: number; quoteAsset: QuoteAsset; totalAmount: bigint; totalQuote: bigint; bestPrice: bigint; totalOrders: number }
    >();

    for (const order of openOrders) {
      if (order.status !== OrderStatus.Open || (quoteAsset && order.quoteAsset !== quoteAsset)) continue;
      const key = `${order.bondId}:${order.quoteAsset}`;
      const price = BigInt(order.pricePerToken);
      const amount = BigInt(order.amount);
      const group = grouped.get(key) || {
        bondId: order.bondId,
        quoteAsset: order.quoteAsset,
        totalAmount: BigInt(0),
        totalQuote: BigInt(0),
        bestPrice: price,
        totalOrders: 0,
      };
      group.totalAmount += amount;
      group.totalQuote += amount * price;
      if (price < group.bestPrice) group.bestPrice = price;
      group.totalOrders += 1;
      grouped.set(key, group);
    }

    const feeds: PriceFeedResponse[] = [];

    for (const group of grouped.values()) {
      feeds.push({
        bondId: group.bondId,
        quoteAsset: group.quoteAsset,
        bestPrice: toBigIntString(group.bestPrice),
        averagePrice: toBigIntString(group.totalQuote / group.totalAmount),
        totalOrders: group.totalOrders,
        totalVolume: toBigIntString(group.totalQuote),
      });
    }

    await this.redis.cacheSet(cacheKey, 30, JSON.stringify(feeds), ['prices']);
    return feeds;
  }

  async getBestPrice(
    bondId: number,
    _side: 'buy' | 'sell',
    quoteAsset?: QuoteAsset,
  ): Promise<PriceLevel> {
    const ordersResult = await this.dexService.listOrders(bondId, 'Open', 1, 100);
    const openOrders = ordersResult.data.filter(
      (order) => !quoteAsset || order.quoteAsset === quoteAsset,
    );

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

  async calculateSlippage(
    bondId: number,
    amount: string,
    quoteAsset: QuoteAsset = 'USDC',
  ): Promise<SlippageResponse> {
    if (!/^[1-9]\d*$/.test(amount)) {
      throw new BadRequestException('amount must be a positive integer string');
    }
    const requestedAmount = BigInt(amount);
    const ordersResult = await this.dexService.listOrders(bondId, 'Open', 1, 100);
    const openOrders = ordersResult.data.filter((order) => order.quoteAsset === quoteAsset);

    const sorted = [...openOrders].sort((a, b) => {
      const priceA = BigInt(a.pricePerToken);
      const priceB = BigInt(b.pricePerToken);
      return priceA < priceB ? -1 : priceA > priceB ? 1 : 0;
    });

    let remaining = requestedAmount;
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

    const fillableAmount = requestedAmount - remaining;
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
    const idealCost = fillableAmount > BigInt(0) && sorted.length > 0
      ? fillableAmount * BigInt(sorted[0].pricePerToken)
      : BigInt(0);
    const slippagePercent = idealCost > BigInt(0) 
      ? Number(((totalCost - idealCost) * BigInt(100)) / idealCost)
      : 0;

    return {
      bondId,
      requestedAmount: toBigIntString(requestedAmount),
      fillableAmount: toBigIntString(fillableAmount),
      unfilledAmount: toBigIntString(unfilledAmount),
      averagePrice: toBigIntString(averagePrice),
      estimatedTotal: toBigIntString(totalCost),
      slippagePercent: Math.max(0, slippagePercent),
      fillabilityStatus,
    };
  }
}
