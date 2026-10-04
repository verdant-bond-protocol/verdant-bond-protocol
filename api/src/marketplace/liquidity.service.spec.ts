import { Test } from '@nestjs/testing';
import { RedisService } from '../common/services/redis.service';
import { DexService } from './dex.service';
import { LiquidityService } from './liquidity.service';
import { OrderResponse, OrderStatus } from './interfaces/marketplace.interface';

describe('LiquidityService', () => {
  let service: LiquidityService;
  const orders: OrderResponse[] = [
    {
      id: 1,
      seller: 'seller-a',
      bondId: 7,
      amount: '1',
      pricePerToken: '10',
      quoteAsset: 'USDC',
      status: OrderStatus.Open,
      createdAt: '1',
      expiresAt: '100',
    },
    {
      id: 2,
      seller: 'seller-b',
      bondId: 7,
      amount: '9',
      pricePerToken: '20',
      quoteAsset: 'USDC',
      status: OrderStatus.Open,
      createdAt: '1',
      expiresAt: '100',
    },
    {
      id: 3,
      seller: 'seller-c',
      bondId: 7,
      amount: '100',
      pricePerToken: '1',
      quoteAsset: 'XLM',
      status: OrderStatus.Open,
      createdAt: '1',
      expiresAt: '100',
    },
  ];

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        LiquidityService,
        { provide: DexService, useValue: { listOrders: jest.fn().mockResolvedValue({ data: orders }) } },
        { provide: RedisService, useValue: { get: jest.fn().mockResolvedValue(null), cacheSet: jest.fn() } },
      ],
    }).compile();
    service = module.get(LiquidityService);
  });

  it('calculates quote-volume-weighted prices separately per quote asset', async () => {
    const feeds = await service.getPriceFeed(7);

    expect(feeds).toEqual([
      {
        bondId: 7,
        quoteAsset: 'USDC',
        bestPrice: '10',
        averagePrice: '19',
        totalOrders: 2,
        totalVolume: '190',
      },
      {
        bondId: 7,
        quoteAsset: 'XLM',
        bestPrice: '1',
        averagePrice: '1',
        totalOrders: 1,
        totalVolume: '100',
      },
    ]);
  });

  it('bounds a low-liquidity quote to the available selected-asset depth', async () => {
    const result = await service.calculateSlippage(7, '100', 'USDC');

    expect(result).toMatchObject({
      requestedAmount: '100',
      fillableAmount: '10',
      unfilledAmount: '90',
      averagePrice: '19',
      estimatedTotal: '190',
      slippagePercent: 90,
      fillabilityStatus: 'partially_fillable',
    });
  });

  it('rejects non-positive and non-integer amount strings', async () => {
    await expect(service.calculateSlippage(7, '0')).rejects.toThrow(
      'amount must be a positive integer string',
    );
    await expect(service.calculateSlippage(7, '1.5')).rejects.toThrow(
      'amount must be a positive integer string',
    );
  });
});
