import { BadRequestException } from '@nestjs/common';
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

      expect(() => service.assertPriceImpactPermitted(evaluation)).toThrow(BadRequestException);
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

      expect(() => service.assertPriceImpactPermitted(evaluation)).toThrow(BadRequestException);
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
});
