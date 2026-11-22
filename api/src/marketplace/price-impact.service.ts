import { Injectable, BadRequestException, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { DexService } from './dex.service';
import {
  LiquidityTier,
  OrderResponse,
  PriceImpactConfig,
  PriceImpactEvaluation,
  PriceImpactLimitSource,
  QuoteAsset,
  OrderStatus,
} from './interfaces/marketplace.interface';
import { RedisService } from '../common/services/redis.service';
import { toBigIntString } from '../common/utils';
import { ApiProblemException } from '../common/errors/problem-exception';
import { ErrorCode } from '../common/errors/error-codes';

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

const BPS = BigInt(10000);
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const TIERS: LiquidityTier[] = ['LIQUID', 'MODERATE', 'ILLIQUID'];

export interface PriceImpactOptions {
  /**
   * The specific resting order a buy will fill (#638). A buy executes against
   * one order at *that order's* price, so the premium over the best ask is the
   * real slippage the buyer pays — even if sweeping the book would look cheap.
   */
  targetOrder?: Pick<OrderResponse, 'id' | 'pricePerToken'>;
  /** Caller's own slippage tolerance; the stricter of this and the tier cap applies. */
  maxPriceImpactBps?: number;
}

/** Returns a human-readable reason when `config` is unusable, otherwise null. */
export function validatePriceImpactConfig(config: PriceImpactConfig): string | null {
  if (!config || typeof config !== 'object') return 'config must be an object';
  if (!POSITIVE_INTEGER.test(String(config.illiquidThresholdAmount))) {
    return 'illiquidThresholdAmount must be a positive integer string';
  }
  if (!POSITIVE_INTEGER.test(String(config.moderateThresholdAmount))) {
    return 'moderateThresholdAmount must be a positive integer string';
  }
  if (BigInt(config.illiquidThresholdAmount) > BigInt(config.moderateThresholdAmount)) {
    return 'illiquidThresholdAmount must not exceed moderateThresholdAmount';
  }
  for (const tier of TIERS) {
    const limit = config.tierImpactLimitsBps?.[tier];
    if (!Number.isInteger(limit) || limit < 0 || limit > 10000) {
      return `tierImpactLimitsBps.${tier} must be an integer between 0 and 10000`;
    }
  }
  const depth = config.maxIlliquidDepthConsumptionBps;
  if (!Number.isInteger(depth) || depth < 1 || depth > 10000) {
    return 'maxIlliquidDepthConsumptionBps must be an integer between 1 and 10000';
  }
  return null;
}

/** Ceiling division: impact is rounded *against* the trade so a cap is never exceeded by rounding. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - BigInt(1)) / denominator;
}

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
            const parsed = JSON.parse(cached) as PriceImpactConfig;
            const problem = validatePriceImpactConfig(parsed);
            if (!problem) return parsed;
            // A corrupted override must not crash every evaluation (BigInt on
            // garbage throws) — and must not silently loosen limits either.
            // Fall back to the conservative defaults and alert.
            this.logger.warn(`Ignoring invalid cached price impact config for bond ${bondId}: ${problem}`);
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

    const problem = validatePriceImpactConfig(updated);
    if (problem) {
      throw new BadRequestException(`Invalid price impact config: ${problem}`);
    }

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
    options: PriceImpactOptions = {},
  ): Promise<PriceImpactEvaluation> {
    if (!POSITIVE_INTEGER.test(amount)) {
      throw new BadRequestException('Amount must be a positive integer string');
    }
    const callerMax = options.maxPriceImpactBps;
    if (callerMax !== undefined && (!Number.isInteger(callerMax) || callerMax < 0 || callerMax > 10000)) {
      throw new BadRequestException('maxPriceImpactBps must be an integer between 0 and 10000');
    }

    const requestedAmount = BigInt(amount);
    const config = await this.getConfig(bondId);

    const ordersResult = await this.dexService.listOrders(bondId, OrderStatus.Open, 1, 100);
    const matchingOrders = ordersResult.data.filter((o) => o.quoteAsset === quoteAsset);

    const sortedAsks = [...matchingOrders].sort((a, b) => {
      const pA = BigInt(a.pricePerToken);
      const pB = BigInt(b.pricePerToken);
      if (pA !== pB) return pA < pB ? -1 : 1;
      return a.id - b.id; // deterministic tie-break → stable bestOrderId
    });

    let totalAvailableDepth = BigInt(0);
    for (const ask of sortedAsks) {
      totalAvailableDepth += BigInt(ask.amount);
    }

    const tier = this.classifyLiquidityTier(totalAvailableDepth, config);
    const tierMaxBps = config.tierImpactLimitsBps[tier];
    const limitSource: PriceImpactLimitSource =
      callerMax !== undefined && callerMax < tierMaxBps ? 'caller' : 'tier';
    const maxAllowedImpactBps = limitSource === 'caller' ? callerMax! : tierMaxBps;
    const limits = {
      maxAllowedImpactBps,
      tierMaxImpactBps: tierMaxBps,
      limitSource,
      ...(callerMax !== undefined ? { callerMaxImpactBps: callerMax } : {}),
      ...(options.targetOrder ? { targetOrderId: options.targetOrder.id } : {}),
    };

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
        ...limits,
        isAllowed: false,
        depthConsumptionRatioBps: 10000,
        maxDepthConsumptionBps: config.maxIlliquidDepthConsumptionBps,
        reason: 'Order book has no available sell orders for this asset',
        suggestedMaxAmount: '0',
      };
    }

    const bestPrice = BigInt(sortedAsks[0].pricePerToken);
    const bestOrderId = sortedAsks[0].id;

    if (bestPrice <= BigInt(0)) {
      // A zero/negative ask makes every ratio meaningless; refuse rather than divide by zero.
      return {
        bondId,
        requestedAmount: toBigIntString(requestedAmount),
        quoteAsset,
        liquidityTier: tier,
        availableDepth: toBigIntString(totalAvailableDepth),
        bestPrice: toBigIntString(bestPrice),
        marginalPrice: toBigIntString(bestPrice),
        averageExecutionPrice: '0',
        totalCost: '0',
        priceImpactBps: 0,
        ...limits,
        bestOrderId,
        isAllowed: false,
        depthConsumptionRatioBps: 10000,
        maxDepthConsumptionBps: config.maxIlliquidDepthConsumptionBps,
        reason: 'Order book contains a non-positive ask price; trading is blocked until it is cleared',
        suggestedMaxAmount: '0',
      };
    }

    const sweepImpactBps = (size: bigint): { cost: bigint; filled: bigint; marginal: bigint; impactBps: number } => {
      let remaining = size;
      let cost = BigInt(0);
      let filled = BigInt(0);
      let marginal = bestPrice;
      for (const ask of sortedAsks) {
        if (remaining <= BigInt(0)) break;
        const orderAmount = BigInt(ask.amount);
        const take = remaining < orderAmount ? remaining : orderAmount;
        const price = BigInt(ask.pricePerToken);
        cost += take * price;
        filled += take;
        remaining -= take;
        marginal = price;
      }
      const ideal = filled * bestPrice;
      const impactBps = ideal > BigInt(0) ? Number(((cost - ideal) * BPS) / ideal) : 0;
      return { cost, filled, marginal, impactBps };
    };

    const sweep = sweepImpactBps(requestedAmount);
    const remaining = requestedAmount - sweep.filled;

    // Premium paid by filling the targeted order instead of the best ask.
    let fillPremiumBps: number | undefined;
    let totalCost = sweep.cost;
    let averageExecutionPrice = sweep.filled > BigInt(0) ? sweep.cost / sweep.filled : BigInt(0);
    let marginalPrice = sweep.marginal;
    if (options.targetOrder) {
      const targetPrice = BigInt(options.targetOrder.pricePerToken);
      fillPremiumBps = targetPrice > bestPrice ? Number(ceilDiv((targetPrice - bestPrice) * BPS, bestPrice)) : 0;
      totalCost = targetPrice * requestedAmount;
      averageExecutionPrice = targetPrice;
      marginalPrice = targetPrice;
    }
    const priceImpactBps = Math.max(sweep.impactBps, fillPremiumBps ?? 0);

    const depthConsumptionRatioBps = Number((requestedAmount * BPS) / totalAvailableDepth);

    let isAllowed = true;
    let reason: string | undefined;

    if (remaining > BigInt(0)) {
      isAllowed = false;
      reason = `Insufficient depth: requested ${requestedAmount} tokens but only ${totalAvailableDepth} available in book`;
    } else if (fillPremiumBps !== undefined && fillPremiumBps > maxAllowedImpactBps) {
      isAllowed = false;
      reason =
        `Order ${options.targetOrder!.id} is priced ${fillPremiumBps} bps above the best ask (order ${bestOrderId}), ` +
        `exceeding the ${limitSource === 'caller' ? 'caller slippage tolerance' : `${tier} tranche limit`} of ${maxAllowedImpactBps} bps`;
    } else if (priceImpactBps > maxAllowedImpactBps) {
      isAllowed = false;
      const pct = `${priceImpactBps} bps (${(priceImpactBps / 100).toFixed(2)}%)`;
      reason = limitSource === 'caller'
        ? `Price impact of ${pct} exceeds caller slippage tolerance of ${maxAllowedImpactBps} bps`
        : `Price impact of ${pct} exceeds limit of ${maxAllowedImpactBps} bps for ${tier} tranche`;
    } else if (tier === 'ILLIQUID' && depthConsumptionRatioBps > config.maxIlliquidDepthConsumptionBps) {
      isAllowed = false;
      reason = `Order consumes ${(depthConsumptionRatioBps / 100).toFixed(1)}% of illiquid tranche depth, exceeding maximum allowable depth consumption of ${(config.maxIlliquidDepthConsumptionBps / 100).toFixed(1)}%`;
    }

    // Largest amount that satisfies every constraint. Retrying with it is
    // guaranteed to pass against the same book (see docs, "Retry").
    let suggestedMax = totalAvailableDepth;
    if (tier === 'ILLIQUID') {
      const depthCap = (totalAvailableDepth * BigInt(config.maxIlliquidDepthConsumptionBps)) / BPS;
      if (depthCap < suggestedMax) suggestedMax = depthCap;
    }
    if (options.targetOrder) {
      // A targeted fill cannot exceed the order itself.
      const targetDepth = BigInt(sortedAsks.find((a) => a.id === options.targetOrder!.id)?.amount ?? '0');
      if (targetDepth < suggestedMax) suggestedMax = targetDepth;
    }
    if (fillPremiumBps !== undefined && fillPremiumBps > maxAllowedImpactBps) {
      // No size of *this* order is acceptable; the remedy is a cheaper order.
      suggestedMax = BigInt(0);
    } else if (sweep.impactBps > maxAllowedImpactBps) {
      const scanAmount = suggestedMax < requestedAmount ? suggestedMax : requestedAmount;
      let low = BigInt(1);
      let high = scanAmount;
      let safeAmount = BigInt(0);
      while (low <= high) {
        const mid = (low + high) / BigInt(2);
        if (sweepImpactBps(mid).impactBps <= maxAllowedImpactBps) {
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
      ...limits,
      bestOrderId,
      ...(fillPremiumBps !== undefined ? { fillPremiumBps } : {}),
      isAllowed,
      depthConsumptionRatioBps,
      maxDepthConsumptionBps: config.maxIlliquidDepthConsumptionBps,
      reason,
      suggestedMaxAmount: toBigIntString(suggestedMax),
    };
  }

  /**
   * Throws a `PRICE_IMPACT_EXCEEDED` problem (#638). The RFC 7807 `context`
   * carries everything a client needs to retry safely; previously the payload
   * was a plain 400 whose details the global filter discarded.
   */
  assertPriceImpactPermitted(evaluation: PriceImpactEvaluation): void {
    if (!evaluation.isAllowed) {
      throw new ApiProblemException(ErrorCode.PRICE_IMPACT_EXCEEDED, {
        status: 400,
        detail: evaluation.reason || 'Trade violates secondary market price impact limits for this tranche',
        context: {
          bondId: evaluation.bondId,
          requestedAmount: evaluation.requestedAmount,
          priceImpactBps: evaluation.priceImpactBps,
          fillPremiumBps: evaluation.fillPremiumBps,
          maxAllowedImpactBps: evaluation.maxAllowedImpactBps,
          limitSource: evaluation.limitSource,
          liquidityTier: evaluation.liquidityTier,
          suggestedMaxAmount: evaluation.suggestedMaxAmount,
          availableDepth: evaluation.availableDepth,
          bestOrderId: evaluation.bestOrderId,
          targetOrderId: evaluation.targetOrderId,
        },
      });
    }
  }
}
