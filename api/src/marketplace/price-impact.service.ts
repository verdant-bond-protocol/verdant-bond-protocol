import { Injectable, BadRequestException, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { DexService } from './dex.service';
import {
  LiquidityTier,
  PriceImpactConfig,
  PriceImpactEvaluation,
  QuoteAsset,
  OrderStatus,
} from './interfaces/marketplace.interface';
import { RedisService } from '../common/services/redis.service';
import { toBigIntString } from '../common/utils';

export const DEFAULT_PRICE_IMPACT_CONFIG: PriceImpactConfig = {
  illiquidThresholdAmount: '5000',
  moderateThresholdAmount: '25000',
  tierImpactLimitsBps: {
    LIQUID: 300,    // 3.00% max price impact
    MODERATE: 600,  // 6.00% max price impact
    ILLIQUID: 1000, // 10.00% max price impact
  },
  maxIlliquidDepthConsumptionBps: 5000, // 50.00% max depth consumption in a single trade
};

@Injectable()
export class PriceImpactService {
  private readonly logger = new Logger(PriceImpactService.name);
  private readonly inMemoryConfig = new Map<number, PriceImpactConfig>();

  constructor(
    @Inject(forwardRef(() => DexService)) private readonly dexService: DexService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  async getConfig(bondId?: number): Promise<PriceImpactConfig> {
    if (bondId !== undefined) {
      if (this.inMemoryConfig.has(bondId)) {
        return this.inMemoryConfig.get(bondId)!;
      }
      if (this.redis) {
        try {
          const cached = await this.redis.get(`price-impact-config:${bondId}`);
          if (cached) {
            return JSON.parse(cached);
          }
        } catch {
          // Fall back gracefully
        }
      }
    }
    return DEFAULT_PRICE_IMPACT_CONFIG;
  }

  async setConfig(bondId: number, patch: Partial<PriceImpactConfig>): Promise<PriceImpactConfig> {
    const current = await this.getConfig(bondId);
    const updated: PriceImpactConfig = {
      ...current,
      ...patch,
      tierImpactLimitsBps: {
        ...current.tierImpactLimitsBps,
        ...(patch.tierImpactLimitsBps ?? {}),
      },
    };

    this.inMemoryConfig.set(bondId, updated);
    if (this.redis) {
      try {
        await this.redis.set(`price-impact-config:${bondId}`, JSON.stringify(updated));
      } catch (err) {
        this.logger.warn(`Failed to persist price impact config in redis for bond ${bondId}: ${err}`);
      }
    }
    return updated;
  }

  classifyLiquidityTier(availableDepth: bigint, config: PriceImpactConfig): LiquidityTier {
    const illiquidThreshold = BigInt(config.illiquidThresholdAmount);
    const moderateThreshold = BigInt(config.moderateThresholdAmount);

    if (availableDepth < illiquidThreshold) {
      return 'ILLIQUID';
    }
    if (availableDepth < moderateThreshold) {
      return 'MODERATE';
    }
    return 'LIQUID';
  }

  async evaluatePriceImpact(
    bondId: number,
    amount: string,
    quoteAsset: QuoteAsset = 'USDC',
  ): Promise<PriceImpactEvaluation> {
    if (!/^[1-9]\d*$/.test(amount)) {
      throw new BadRequestException('Amount must be a positive integer string');
    }

    const requestedAmount = BigInt(amount);
    const config = await this.getConfig(bondId);

    const ordersResult = await this.dexService.listOrders(bondId, OrderStatus.Open, 1, 100);
    const matchingOrders = ordersResult.data.filter((o) => o.quoteAsset === quoteAsset);

    const sortedAsks = [...matchingOrders].sort((a, b) => {
      const pA = BigInt(a.pricePerToken);
      const pB = BigInt(b.pricePerToken);
      return pA < pB ? -1 : pA > pB ? 1 : 0;
    });

    let totalAvailableDepth = BigInt(0);
    for (const ask of sortedAsks) {
      totalAvailableDepth += BigInt(ask.amount);
    }

    const tier = this.classifyLiquidityTier(totalAvailableDepth, config);
    const maxAllowedImpactBps = config.tierImpactLimitsBps[tier];

    if (sortedAsks.length === 0 || totalAvailableDepth === BigInt(0)) {
      return {
        bondId,
        requestedAmount: toBigIntString(requestedAmount),
        quoteAsset,
        liquidityTier: tier,
        availableDepth: '0',
        bestPrice: '0',
        marginalPrice: '0',
        averageExecutionPrice: '0',
        totalCost: '0',
        priceImpactBps: 0,
        maxAllowedImpactBps,
        isAllowed: false,
        depthConsumptionRatioBps: 10000,
        maxDepthConsumptionBps: config.maxIlliquidDepthConsumptionBps,
        reason: 'Order book has no available sell orders for this asset',
        suggestedMaxAmount: '0',
      };
    }

    const bestPrice = BigInt(sortedAsks[0].pricePerToken);
    let remaining = requestedAmount;
    let totalCost = BigInt(0);
    let totalFilled = BigInt(0);
    let marginalPrice = bestPrice;

    for (const ask of sortedAsks) {
      if (remaining <= BigInt(0)) break;
      const orderAmount = BigInt(ask.amount);
      const take = remaining < orderAmount ? remaining : orderAmount;
      const orderPrice = BigInt(ask.pricePerToken);

      totalCost += take * orderPrice;
      totalFilled += take;
      remaining -= take;
      marginalPrice = orderPrice;
    }

    const averageExecutionPrice = totalFilled > BigInt(0) ? totalCost / totalFilled : BigInt(0);
    const idealCost = totalFilled * bestPrice;
    const priceImpactBps = idealCost > BigInt(0)
      ? Number(((totalCost - idealCost) * BigInt(10000)) / idealCost)
      : 0;

    const depthConsumptionRatioBps = totalAvailableDepth > BigInt(0)
      ? Number((requestedAmount * BigInt(10000)) / totalAvailableDepth)
      : 10000;

    let isAllowed = true;
    let reason: string | undefined;

    if (remaining > BigInt(0)) {
      isAllowed = false;
      reason = `Insufficient depth: requested ${requestedAmount} tokens but only ${totalAvailableDepth} available in book`;
    } else if (priceImpactBps > maxAllowedImpactBps) {
      isAllowed = false;
      reason = `Price impact of ${priceImpactBps} bps (${(priceImpactBps / 100).toFixed(2)}%) exceeds limit of ${maxAllowedImpactBps} bps for ${tier} tranche`;
    } else if (
      tier === 'ILLIQUID' &&
      depthConsumptionRatioBps > config.maxIlliquidDepthConsumptionBps
    ) {
      isAllowed = false;
      reason = `Order consumes ${(depthConsumptionRatioBps / 100).toFixed(1)}% of illiquid tranche depth, exceeding maximum allowable depth consumption of ${(config.maxIlliquidDepthConsumptionBps / 100).toFixed(1)}%`;
    }

    // Determine suggested max amount that satisfies both constraints
    let suggestedMax = totalAvailableDepth;
    if (tier === 'ILLIQUID') {
      const depthCap = (totalAvailableDepth * BigInt(config.maxIlliquidDepthConsumptionBps)) / BigInt(10000);
      if (depthCap < suggestedMax) {
        suggestedMax = depthCap;
      }
    }

    // Binary search/scan to find max amount within price impact limit
    const scanAmount = suggestedMax < requestedAmount ? suggestedMax : requestedAmount;
    if (priceImpactBps > maxAllowedImpactBps) {
      let low = BigInt(1);
      let high = scanAmount;
      let safeAmount = BigInt(0);

      while (low <= high) {
        const mid = (low + high) / BigInt(2);
        let curRem = mid;
        let curCost = BigInt(0);
        for (const ask of sortedAsks) {
          if (curRem <= BigInt(0)) break;
          const amt = BigInt(ask.amount);
          const t = curRem < amt ? curRem : amt;
          curCost += t * BigInt(ask.pricePerToken);
          curRem -= t;
        }
        const curIdeal = mid * bestPrice;
        const curImpact = curIdeal > BigInt(0) ? Number(((curCost - curIdeal) * BigInt(10000)) / curIdeal) : 0;
        if (curImpact <= maxAllowedImpactBps) {
          safeAmount = mid;
          low = mid + BigInt(1);
        } else {
          high = mid - BigInt(1);
        }
      }
      suggestedMax = safeAmount;
    }

    return {
      bondId,
      requestedAmount: toBigIntString(requestedAmount),
      quoteAsset,
      liquidityTier: tier,
      availableDepth: toBigIntString(totalAvailableDepth),
      bestPrice: toBigIntString(bestPrice),
      marginalPrice: toBigIntString(marginalPrice),
      averageExecutionPrice: toBigIntString(averageExecutionPrice),
      totalCost: toBigIntString(totalCost),
      priceImpactBps,
      maxAllowedImpactBps,
      isAllowed,
      depthConsumptionRatioBps,
      maxDepthConsumptionBps: config.maxIlliquidDepthConsumptionBps,
      reason,
      suggestedMaxAmount: toBigIntString(suggestedMax),
    };
  }

  assertPriceImpactPermitted(evaluation: PriceImpactEvaluation): void {
    if (!evaluation.isAllowed) {
      throw new BadRequestException({
        error: 'PRICE_IMPACT_EXCEEDED',
        message: evaluation.reason || 'Trade violates secondary market price impact limits for this tranche',
        details: {
          bondId: evaluation.bondId,
          requestedAmount: evaluation.requestedAmount,
          priceImpactBps: evaluation.priceImpactBps,
          maxAllowedImpactBps: evaluation.maxAllowedImpactBps,
          liquidityTier: evaluation.liquidityTier,
          suggestedMaxAmount: evaluation.suggestedMaxAmount,
          availableDepth: evaluation.availableDepth,
        },
      });
    }
  }
}
