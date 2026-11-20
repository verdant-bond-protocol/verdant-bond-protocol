import { Test } from '@nestjs/testing';
import { DexReconciliationService } from './dex.reconciliation.service';
import { DexService } from './dex.service';
import { RedisService } from '../common/services/redis.service';
import { OrderStatus } from './interfaces/marketplace.interface';

function openOrder(id: number, overrides: Partial<any> = {}): any {
  return {
    id,
    seller: 'G_SELLER',
    bondId: 1,
    amount: '10',
    pricePerToken: '5',
    quoteAsset: 'USDC',
    status: OrderStatus.Open,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('DexReconciliationService', () => {
  let service: DexReconciliationService;
  let dexService: any;
  let redis: any;

  beforeEach(async () => {
    dexService = {
      getQuoteBalance: jest.fn(),
      getIndexedQuoteBalance: jest.fn(),
      setIndexedQuoteBalance: jest.fn(),
      listOrders: jest.fn(),
      fetchOrderFromLedger: jest.fn(),
      getOrder: jest.fn(),
      getOrderCount: jest.fn(),
    };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      setEx: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      delPattern: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DexReconciliationService,
        { provide: DexService, useValue: dexService },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(DexReconciliationService);
  });

  it('seeds the index on first sighting and reports no mismatches', async () => {
    dexService.getQuoteBalance.mockResolvedValue({ address: 'G1', asset: 'USDC', balance: '200' });
    dexService.getIndexedQuoteBalance.mockResolvedValue(null);
    dexService.listOrders.mockResolvedValue({ data: [] });
    dexService.getOrderCount.mockResolvedValue(0);

    const report = await service.reconcile({ wallets: ['G1'], assets: ['USDC'] });

    expect(report.mismatches).toHaveLength(0);
    expect(dexService.setIndexedQuoteBalance).toHaveBeenCalledWith('G1', 'USDC', '200');
    expect(redis.setEx).toHaveBeenCalled();
  });

  it('detects a changed on-chain balance vs the stale index (stale cache)', async () => {
    dexService.getQuoteBalance.mockResolvedValue({ address: 'G1', asset: 'USDC', balance: '200' });
    dexService.getIndexedQuoteBalance.mockResolvedValue('100');
    dexService.listOrders.mockResolvedValue({ data: [] });
    dexService.getOrderCount.mockResolvedValue(0);

    const report = await service.reconcile({ wallets: ['G1'], assets: ['USDC'] });

    expect(report.mismatches).toHaveLength(1);
    const m = report.mismatches[0];
    expect(m.type).toBe('balance_mismatch');
    expect(m.observed).toBe('100');
    expect(m.expected).toBe('200');
    // A mismatch must NOT silently re-seed the index.
    expect(dexService.setIndexedQuoteBalance).not.toHaveBeenCalled();
  });

  it('flags a stale order cache where the API shows Open but the ledger does not', async () => {
    dexService.getQuoteBalance.mockResolvedValue({ address: 'G1', asset: 'USDC', balance: '1000' });
    dexService.getIndexedQuoteBalance.mockResolvedValue(null);
    dexService.listOrders.mockResolvedValue({ data: [openOrder(1, { seller: 'G1' })] });
    dexService.getOrder.mockResolvedValue(openOrder(1, { status: OrderStatus.Open }));
    dexService.fetchOrderFromLedger.mockResolvedValue(openOrder(1, { status: OrderStatus.Filled }));
    dexService.getOrderCount.mockResolvedValue(1);

    const report = await service.reconcile({ wallets: ['G1'], assets: ['USDC'] });

    const m = report.mismatches.find((x) => x.type === 'stale_order_cache');
    expect(m).toBeDefined();
    expect(m?.orderId).toBe(1);
    expect(m?.observed).toBe(OrderStatus.Open);
    expect(m?.expected).toBe(OrderStatus.Filled);
  });

  it('detects an open order that has dropped out of the API index (missing order)', async () => {
    dexService.getQuoteBalance.mockResolvedValue({ address: 'G_SELLER', asset: 'USDC', balance: '1000' });
    dexService.getIndexedQuoteBalance.mockResolvedValue(null);
    // API index only knows orders 1 and 3 as open.
    dexService.listOrders.mockResolvedValue({
      data: [openOrder(1), openOrder(3)],
    });
    dexService.getOrder.mockImplementation(async (id: number) => openOrder(id));
    // On-chain order 2 is open but absent from the index.
    dexService.fetchOrderFromLedger.mockImplementation(async (id: number) => openOrder(id));
    dexService.getOrderCount.mockResolvedValue(3);

    const report = await service.reconcile({ wallets: ['G_SELLER'], assets: ['USDC'] });

    const m = report.mismatches.find((x) => x.type === 'missing_order' && x.orderId === 2);
    expect(m).toBeDefined();
  });

  it('flags an order whose seller no longer holds enough escrow (escrow invariant)', async () => {
    // required = 5 * 10 = 50, but seller holds only 10.
    dexService.getQuoteBalance.mockResolvedValue({ address: 'G_SELLER', asset: 'USDC', balance: '10' });
    dexService.getIndexedQuoteBalance.mockResolvedValue(null);
    dexService.listOrders.mockResolvedValue({ data: [openOrder(1, { seller: 'G_SELLER' })] });
    dexService.getOrder.mockResolvedValue(openOrder(1, { status: OrderStatus.Open }));
    dexService.fetchOrderFromLedger.mockResolvedValue(openOrder(1, { status: OrderStatus.Open }));
    dexService.getOrderCount.mockResolvedValue(1);

    const report = await service.reconcile({ wallets: ['G_SELLER'], assets: ['USDC'] });

    const m = report.mismatches.find((x) => x.type === 'order_escrow_invariant');
    expect(m).toBeDefined();
    expect(m?.orderId).toBe(1);
  });

  it('repair() evicts the stale cache / re-syncs the index per mismatch type', async () => {
    const report = {
      correlationId: 'test-corr',
      mismatches: [
        { type: 'balance_mismatch', walletAddress: 'G1', asset: 'USDC', expected: '200', observed: '100', correlationId: 'test-corr' },
        { type: 'stale_order_cache', orderId: 1, expected: 'Filled', observed: 'Open', correlationId: 'test-corr' },
        { type: 'missing_order', orderId: 2, expected: 'Open', observed: 'absent', correlationId: 'test-corr' },
        { type: 'order_escrow_invariant', orderId: 3, correlationId: 'test-corr' },
      ],
    } as any;

    const actions = await service.repair(report);

    expect(redis.del).toHaveBeenCalledWith('quote:balance:G1:USDC');
    expect(redis.delPattern).toHaveBeenCalledWith('orders:*');
    expect(actions.length).toBe(4);
  });

  it('persists the report so operators can fetch it later', async () => {
    dexService.getQuoteBalance.mockResolvedValue({ address: 'G1', asset: 'USDC', balance: '200' });
    dexService.getIndexedQuoteBalance.mockResolvedValue(null);
    dexService.listOrders.mockResolvedValue({ data: [] });
    dexService.getOrderCount.mockResolvedValue(0);

    await service.reconcile({ wallets: ['G1'], assets: ['USDC'] });

    expect(redis.setEx).toHaveBeenCalled();
  });
});
