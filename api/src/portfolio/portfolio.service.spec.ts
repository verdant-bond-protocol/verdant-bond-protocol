import { Test } from '@nestjs/testing';
import { PortfolioService } from './portfolio.service';
import { BondsService } from '../bonds/bonds.service';
import { DexService } from '../marketplace/dex.service';
import { RedisService } from '../common/services/redis.service';
import { OrderStatus } from '../marketplace/interfaces/marketplace.interface';

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('PortfolioService', () => {
  let service: PortfolioService;
  let redis: any;

  const bondsService = {
    findHeldByAddress: jest.fn(),
    getClaimableCredits: jest.fn(),
    getRetiredCredits: jest.fn(),
  };
  const dexService = {
    listOrders: jest.fn(),
  };

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      setEx: jest.fn().mockResolvedValue(undefined),
    };
    bondsService.findHeldByAddress.mockReset();
    bondsService.getClaimableCredits.mockReset();
    bondsService.getRetiredCredits.mockReset();
    dexService.listOrders.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        PortfolioService,
        { provide: BondsService, useValue: bondsService },
        { provide: DexService, useValue: dexService },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = moduleRef.get(PortfolioService);
  });

  it('aggregates bonds, listings, credits, and pending actions for a wallet', async () => {
    bondsService.findHeldByAddress.mockResolvedValue([
      { id: 1, balance: '100', status: 'Active', maturityStatus: 'Active', maturityDate: 99_999_999_999 },
      { id: 2, balance: '50', status: 'Active', maturityStatus: 'Active', maturityDate: 99_999_999_999 },
    ]);
    bondsService.getClaimableCredits.mockResolvedValue([
      { bondId: 1, amount: '10' },
      { bondId: 2, amount: '0' },
    ]);
    bondsService.getRetiredCredits.mockResolvedValue([
      { id: 5, bondId: 1, amount: '5', creditType: 'Carbon', retiredAt: 1700000000 },
    ]);
    dexService.listOrders.mockResolvedValue({
      data: [
        { id: 10, seller: WALLET, bondId: 1, amount: '20', pricePerToken: '1', quoteAsset: 'USDC', status: OrderStatus.Open, createdAt: '2024-01-01T00:00:00Z' },
        { id: 11, seller: WALLET, bondId: 2, amount: '5', pricePerToken: '2', quoteAsset: 'USDC', status: OrderStatus.PartiallyFilled, createdAt: '2024-01-01T00:00:00Z' },
        { id: 12, seller: 'GOTHER', bondId: 1, amount: '9', pricePerToken: '1', quoteAsset: 'USDC', status: OrderStatus.Open, createdAt: '2024-01-01T00:00:00Z' },
        { id: 13, seller: WALLET, bondId: 3, amount: '1', pricePerToken: '1', quoteAsset: 'USDC', status: OrderStatus.Filled, createdAt: '2024-01-01T00:00:00Z' },
      ],
    });

    const portfolio = await service.getPortfolio(WALLET);

    expect(portfolio.bondsHeld).toHaveLength(2);
    // Only the wallet's open/partially-filled listings, excluding other sellers
    // and filled orders.
    expect(portfolio.openListings.map((l) => l.id).sort()).toEqual([10, 11]);
    expect(portfolio.claimableCredits).toEqual([{ bondId: 1, amount: '10' }]);
    expect(portfolio.retiredCredits).toHaveLength(1);
    // pending: coupon_claim for bond 1, two maturities, two open listings
    const types = portfolio.pendingActions.map((p) => p.type);
    expect(types.filter((t) => t === 'coupon_claim')).toHaveLength(1);
    expect(types.filter((t) => t === 'maturity')).toHaveLength(2);
    expect(types.filter((t) => t === 'open_listing')).toHaveLength(2);
    expect(redis.setEx).toHaveBeenCalledWith(`portfolio:${WALLET}`, 30, expect.any(String));
  });

  it('serves from cache when present and not forced', async () => {
    const cached = JSON.stringify({ address: WALLET, bondsHeld: [], openListings: [], claimableCredits: [], retiredCredits: [], pendingActions: [], generatedAt: new Date().toISOString() });
    redis.get.mockResolvedValue(cached);

    const portfolio = await service.getPortfolio(WALLET);
    expect(portfolio).toEqual(JSON.parse(cached));
    expect(bondsService.findHeldByAddress).not.toHaveBeenCalled();
  });

  it('bypasses cache when forced', async () => {
    redis.get.mockResolvedValue('stale');
    bondsService.findHeldByAddress.mockResolvedValue([]);
    bondsService.getClaimableCredits.mockResolvedValue([]);
    bondsService.getRetiredCredits.mockResolvedValue([]);
    dexService.listOrders.mockResolvedValue({ data: [] });

    await service.getPortfolio(WALLET, { force: true });
    expect(bondsService.findHeldByAddress).toHaveBeenCalledWith(WALLET);
  });
});
