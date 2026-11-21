import { BadRequestException } from '@nestjs/common';
import { ApiProblemException } from '../common/errors/problem-exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PriceImpactService, DEFAULT_PRICE_IMPACT_CONFIG } from './price-impact.service';
import { DexService } from './dex.service';
import { OrderResponse, OrderStatus } from './interfaces/marketplace.interface';

describe('PriceImpactService (#471)', () => {
  let service: PriceImpactService;
  let dexServiceMock: Partial<DexService>;

  const mockOrders: OrderResponse[] = [
    {
      id: 1,
      seller: 'GBSELLER1',
      bondId: 101,
      amount: '1000',
      pricePerToken: '100', // 100 per token
      quoteAsset: 'USDC',
      status: OrderStatus.Open,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
    {
      id: 2,
      seller: 'GBSELLER2',
      bondId: 101,
      amount: '1000',
      pricePerToken: '110', // 10% above best
      quoteAsset: 'USDC',
      status: OrderStatus.Open,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
    {
      id: 3,
      seller: 'GBSELLER3',
      bondId: 101,
      amount: '1000',
      pricePerToken: '150', // 50% above best
      quoteAsset: 'USDC',
      status: OrderStatus.Open,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  ];

  beforeEach(() => {
    dexServiceMock = {
      listOrders: jest.fn().mockImplementation(async (bondId, status) => ({
        data: mockOrders.filter((o) => (!bondId || o.bondId === bondId) && (!status || o.status === status)),
        meta: { page: 1, limit: 100, total: 3, totalPages: 1 },
      })),
    };
    service = new PriceImpactService(dexServiceMock as DexService);
  });

  describe('Liquidity Tier Classification', () => {
    it('classifies tranches with depth < 5,000 as ILLIQUID', () => {
      const tier = service.classifyLiquidityTier(BigInt(3000), DEFAULT_PRICE_IMPACT_CONFIG);
      expect(tier).toBe('ILLIQUID');
    });

    it('classifies tranches with depth between 5,000 and 25,000 as MODERATE', () => {
      const tier = service.classifyLiquidityTier(BigInt(15000), DEFAULT_PRICE_IMPACT_CONFIG);
      expect(tier).toBe('MODERATE');
    });

    it('classifies tranches with depth >= 25,000 as LIQUID', () => {
      const tier = service.classifyLiquidityTier(BigInt(50000), DEFAULT_PRICE_IMPACT_CONFIG);
      expect(tier).toBe('LIQUID');
    });
  });

  describe('Normal Execution Path', () => {
    it('permits trades on illiquid tranches that stay within price impact and depth limits', async () => {
      // 3,000 total depth = ILLIQUID. 500 tokens is 16.7% depth consumption (< 50% max) and fills at 100 (0 bps impact)
      const evaluation = await service.evaluatePriceImpact(101, '500', 'USDC');
      expect(evaluation.isAllowed).toBe(true);
      expect(evaluation.liquidityTier).toBe('ILLIQUID');
      expect(evaluation.priceImpactBps).toBe(0);
      expect(evaluation.maxAllowedImpactBps).toBe(1000);
      expect(evaluation.bestPrice).toBe('100');
      expect(evaluation.averageExecutionPrice).toBe('100');

      expect(() => service.assertPriceImpactPermitted(evaluation)).not.toThrow();
    });

    it('calculates weighted price impact accurately across multiple price levels', async () => {
      // 1500 tokens: fills 1000 @ 100 + 500 @ 110 = 155,000 totalCost.
      // avgPrice = 155,000 / 1500 = 103.3333.
      // idealCost = 1500 * 100 = 150,000.
      // impactBps = ((155,000 - 150,000) * 10000) / 150,000 = 50,000 / 150 = 333 bps (3.33%).
      // 1500 tokens is 50% of 3000 depth (exactly max allowed 50%).
      const evaluation = await service.evaluatePriceImpact(101, '1500', 'USDC');
      expect(evaluation.priceImpactBps).toBe(333);
      expect(evaluation.isAllowed).toBe(true);
      expect(evaluation.liquidityTier).toBe('ILLIQUID');
    });
  });

  describe('Failure Path: Price Impact & Depth Consumption Violations', () => {
    it('blocks trades exceeding the depth consumption cap for illiquid tranches', async () => {
      // 2000 tokens consumes 66.7% of the 3000 depth, exceeding 50% cap
      const evaluation = await service.evaluatePriceImpact(101, '2000', 'USDC');
      expect(evaluation.isAllowed).toBe(false);
      expect(evaluation.reason).toContain('exceeding maximum allowable depth consumption');
      expect(evaluation.suggestedMaxAmount).toBe('1500');

      expect(() => service.assertPriceImpactPermitted(evaluation)).toThrow(ApiProblemException);
    });

    it('blocks trades where price impact exceeds the maximum allowed bps', async () => {
      // Set custom tight limit for testing
      await service.setConfig(101, {
        tierImpactLimitsBps: {
          LIQUID: 100,
          MODERATE: 200,
          ILLIQUID: 200, // 2.00% max
        },
      });

      // 1500 tokens causes 333 bps impact (> 200 bps max)
      const evaluation = await service.evaluatePriceImpact(101, '1500', 'USDC');
      expect(evaluation.isAllowed).toBe(false);
      expect(evaluation.priceImpactBps).toBe(333);
      expect(evaluation.maxAllowedImpactBps).toBe(200);
      expect(evaluation.reason).toContain('exceeds limit of 200 bps');
      expect(BigInt(evaluation.suggestedMaxAmount!)).toBeLessThan(BigInt(1500));

      expect(() => service.assertPriceImpactPermitted(evaluation)).toThrow(ApiProblemException);
    });

    it('rejects trades when requested amount exceeds available book depth', async () => {
      const evaluation = await service.evaluatePriceImpact(101, '5000', 'USDC');
      expect(evaluation.isAllowed).toBe(false);
      expect(evaluation.reason).toContain('Insufficient depth');
    });

    it('rejects trades on empty order books safely without zero-division', async () => {
      (dexServiceMock.listOrders as jest.Mock).mockResolvedValueOnce({ data: [], meta: {} });
      const evaluation = await service.evaluatePriceImpact(999, '100', 'USDC');
      expect(evaluation.isAllowed).toBe(false);
      expect(evaluation.reason).toContain('no available sell orders');
      expect(evaluation.priceImpactBps).toBe(0);
    });

    it('throws BadRequestException for invalid amount strings', async () => {
      await expect(service.evaluatePriceImpact(101, '0', 'USDC')).rejects.toThrow(BadRequestException);
      await expect(service.evaluatePriceImpact(101, '-50', 'USDC')).rejects.toThrow(BadRequestException);
      await expect(service.evaluatePriceImpact(101, 'abc', 'USDC')).rejects.toThrow(BadRequestException);
    });
  });

  describe('Retry Path: Convergence on Suggested Max Amount', () => {
    it('allows a subsequent retry using suggestedMaxAmount after an initial rejection', async () => {
      // 2500 tokens is blocked
      const firstTry = await service.evaluatePriceImpact(101, '2500', 'USDC');
      expect(firstTry.isAllowed).toBe(false);
      expect(firstTry.suggestedMaxAmount).toBeDefined();

      // Retry with suggestedMaxAmount
      const retry = await service.evaluatePriceImpact(101, firstTry.suggestedMaxAmount!, 'USDC');
      expect(retry.isAllowed).toBe(true);
      expect(retry.priceImpactBps).toBeLessThanOrEqual(retry.maxAllowedImpactBps);
    });
  });

  describe('Configuration & Authorization Path', () => {
    it('allows operators to set and retrieve custom tranche price impact parameters', async () => {
      const updated = await service.setConfig(101, {
        illiquidThresholdAmount: '10000',
        maxIlliquidDepthConsumptionBps: 4000,
      });

      expect(updated.illiquidThresholdAmount).toBe('10000');
      expect(updated.maxIlliquidDepthConsumptionBps).toBe(4000);

      const retrieved = await service.getConfig(101);
      expect(retrieved.illiquidThresholdAmount).toBe('10000');
      expect(retrieved.maxIlliquidDepthConsumptionBps).toBe(4000);
    });
  });
  describe('#638 Targeted fills in thin markets', () => {
    const order = (id: number) => mockOrders.find((o) => o.id === id)!;

    it('normal path: filling the best ask carries zero premium', async () => {
      const evaluation = await service.evaluatePriceImpact(101, '500', 'USDC', { targetOrder: order(1) });
      expect(evaluation.isAllowed).toBe(true);
      expect(evaluation.fillPremiumBps).toBe(0);
      expect(evaluation.bestOrderId).toBe(1);
      expect(evaluation.targetOrderId).toBe(1);
      expect(evaluation.totalCost).toBe('50000');
    });

    it('failure path: blocks an outlier ask that a book sweep would have approved', async () => {
      // Sweeping 500 tokens from the best ask costs 0 bps, but this buy fills
      // order 3 at 150 — a 5,000 bps premium the old check never saw.
      const sweepOnly = await service.evaluatePriceImpact(101, '500', 'USDC');
      expect(sweepOnly.isAllowed).toBe(true);

      const evaluation = await service.evaluatePriceImpact(101, '500', 'USDC', { targetOrder: order(3) });
      expect(evaluation.isAllowed).toBe(false);
      expect(evaluation.fillPremiumBps).toBe(5000);
      expect(evaluation.priceImpactBps).toBe(5000);
      expect(evaluation.averageExecutionPrice).toBe('150');
      expect(evaluation.suggestedMaxAmount).toBe('0');
      expect(evaluation.bestOrderId).toBe(1);
      expect(evaluation.reason).toContain('above the best ask');
    });

    it('rounds the premium up so a cap is never exceeded by truncation', async () => {
      (dexServiceMock.listOrders as jest.Mock).mockResolvedValueOnce({
        data: [
          { ...mockOrders[0], id: 10, pricePerToken: '3', amount: '10000' },
          { ...mockOrders[0], id: 11, pricePerToken: '4', amount: '10000' },
        ],
        meta: {},
      });
      // (4 - 3) / 3 = 3333.33… bps → 3334
      const evaluation = await service.evaluatePriceImpact(101, '1', 'USDC', {
        targetOrder: { id: 11, pricePerToken: '4' },
      });
      expect(evaluation.fillPremiumBps).toBe(3334);
    });

    it('caps suggestedMaxAmount at the targeted order size', async () => {
      const evaluation = await service.evaluatePriceImpact(101, '2000', 'USDC', { targetOrder: order(1) });
      expect(evaluation.isAllowed).toBe(false);
      expect(BigInt(evaluation.suggestedMaxAmount!)).toBeLessThanOrEqual(BigInt(1000));
    });

    it('blocks trading when the book holds a non-positive ask (no zero-division)', async () => {
      (dexServiceMock.listOrders as jest.Mock).mockResolvedValueOnce({
        data: [{ ...mockOrders[0], id: 20, pricePerToken: '0' }],
        meta: {},
      });
      const evaluation = await service.evaluatePriceImpact(101, '10', 'USDC');
      expect(evaluation.isAllowed).toBe(false);
      expect(evaluation.reason).toContain('non-positive ask');
    });
  });

  describe('#638 Caller slippage tolerance', () => {
    it('applies the stricter caller tolerance and reports it as the limit source', async () => {
      // Order 2 is 1,000 bps above best; ILLIQUID tier cap is 1,000 so the tier alone allows it.
      const tierOnly = await service.evaluatePriceImpact(101, '100', 'USDC', { targetOrder: mockOrders[1] });
      expect(tierOnly.isAllowed).toBe(true);
      expect(tierOnly.limitSource).toBe('tier');

      const evaluation = await service.evaluatePriceImpact(101, '100', 'USDC', {
        targetOrder: mockOrders[1],
        maxPriceImpactBps: 250,
      });
      expect(evaluation.isAllowed).toBe(false);
      expect(evaluation.limitSource).toBe('caller');
      expect(evaluation.maxAllowedImpactBps).toBe(250);
      expect(evaluation.tierMaxImpactBps).toBe(1000);
      expect(evaluation.callerMaxImpactBps).toBe(250);
      expect(evaluation.reason).toContain('caller slippage tolerance');
    });

    it('never lets a caller loosen the tier cap', async () => {
      const evaluation = await service.evaluatePriceImpact(101, '100', 'USDC', {
        targetOrder: mockOrders[2],
        maxPriceImpactBps: 10000,
      });
      expect(evaluation.limitSource).toBe('tier');
      expect(evaluation.maxAllowedImpactBps).toBe(1000);
      expect(evaluation.isAllowed).toBe(false);
    });

    it('treats a zero tolerance as "best ask only"', async () => {
      const best = await service.evaluatePriceImpact(101, '100', 'USDC', { targetOrder: mockOrders[0], maxPriceImpactBps: 0 });
      const worse = await service.evaluatePriceImpact(101, '100', 'USDC', { targetOrder: mockOrders[1], maxPriceImpactBps: 0 });
      expect(best.isAllowed).toBe(true);
      expect(worse.isAllowed).toBe(false);
    });

    it('rejects an out-of-range tolerance', async () => {
      await expect(service.evaluatePriceImpact(101, '100', 'USDC', { maxPriceImpactBps: -1 })).rejects.toThrow(BadRequestException);
      await expect(service.evaluatePriceImpact(101, '100', 'USDC', { maxPriceImpactBps: 10001 })).rejects.toThrow(BadRequestException);
      await expect(service.evaluatePriceImpact(101, '100', 'USDC', { maxPriceImpactBps: 1.5 })).rejects.toThrow(BadRequestException);
    });

    it('retry path: suggestedMaxAmount under a caller tolerance converges on an allowed trade', async () => {
      const first = await service.evaluatePriceImpact(101, '1500', 'USDC', { maxPriceImpactBps: 100 });
      expect(first.isAllowed).toBe(false);
      const retry = await service.evaluatePriceImpact(101, first.suggestedMaxAmount!, 'USDC', { maxPriceImpactBps: 100 });
      expect(retry.isAllowed).toBe(true);
      expect(retry.priceImpactBps).toBeLessThanOrEqual(100);
    });
  });

  describe('#638 Structured rejection for API consumers', () => {
    it('throws PRICE_IMPACT_EXCEEDED with retry guidance in the problem context', async () => {
      const evaluation = await service.evaluatePriceImpact(101, '500', 'USDC', { targetOrder: mockOrders[2] });
      try {
        service.assertPriceImpactPermitted(evaluation);
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiProblemException);
        const problem = error as ApiProblemException;
        expect(problem.code).toBe(ErrorCode.PRICE_IMPACT_EXCEEDED);
        expect(problem.getStatus()).toBe(400);
        expect(problem.context).toMatchObject({
          bondId: 101,
          suggestedMaxAmount: '0',
          bestOrderId: 1,
          targetOrderId: 3,
          fillPremiumBps: 5000,
          limitSource: 'tier',
        });
      }
    });
  });

  describe('#638 Config validation and rollback safety', () => {
    it.each([
      [{ illiquidThresholdAmount: 'abc' }, 'illiquidThresholdAmount'],
      [{ illiquidThresholdAmount: '0' }, 'illiquidThresholdAmount'],
      [{ illiquidThresholdAmount: '30000' }, 'must not exceed'],
      [{ maxIlliquidDepthConsumptionBps: 0 }, 'maxIlliquidDepthConsumptionBps'],
      [{ tierImpactLimitsBps: { LIQUID: -5, MODERATE: 600, ILLIQUID: 1000 } }, 'LIQUID'],
    ])('rejects %j and keeps the previous config', async (patch, message) => {
      await expect(service.setConfig(101, patch as any)).rejects.toThrow(message as string);
      expect(await service.getConfig(101)).toEqual(DEFAULT_PRICE_IMPACT_CONFIG);
    });

    it('falls back to defaults when the cached override is corrupted', async () => {
      const redis = { get: jest.fn().mockResolvedValue(JSON.stringify({ illiquidThresholdAmount: 'garbage' })), set: jest.fn() };
      const withRedis = new PriceImpactService(dexServiceMock as DexService, redis as any);
      expect(await withRedis.getConfig(101)).toEqual(DEFAULT_PRICE_IMPACT_CONFIG);
      const evaluation = await withRedis.evaluatePriceImpact(101, '500', 'USDC');
      expect(evaluation.maxAllowedImpactBps).toBe(1000);
    });
  });
});
