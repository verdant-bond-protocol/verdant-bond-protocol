import { DexService } from './dex.service';
import { PriceImpactService } from './price-impact.service';
import { OrderResponse, OrderStatus } from './interfaces/marketplace.interface';
import { ApiProblemException } from '../common/errors/problem-exception';
import { ErrorCode } from '../common/errors/error-codes';

/**
 * #638 vertical slice: the buy path enforces the targeted-fill premium and the
 * buyer's own slippage tolerance *before* any contract call, so a rejection
 * consumes no nonce and moves no escrow (financial invariant).
 */
describe('DexService.buyBondTokens thin-market guard (#638)', () => {
  const BUYER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const order = (id: number, price: string, amount = '100'): OrderResponse => ({
    id,
    seller: 'GSELLER',
    bondId: 7,
    amount,
    pricePerToken: price,
    quoteAsset: 'USDC',
    status: OrderStatus.Open,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  // Thin book: one cheap ask, one outlier 80% above it.
  const book = [order(1, '100'), order(2, '180')];

  function build() {
    const invokeContractMethod = jest.fn().mockResolvedValue({ transactionHash: 'tx' });
    const svc = new DexService(
      { invokeContractMethod } as any,
      { getKeypairFromSecret: () => ({ publicKey: () => BUYER }) } as any,
      {} as any,
      { invalidateTag: jest.fn(), delPattern: jest.fn(), del: jest.fn().mockResolvedValue(undefined) } as any,
      { adminSecret: () => 'SADMIN' } as any,
      { getDexRouterAddress: () => 'CDEX' } as any,
      { recordTransfer: jest.fn() } as any,
      { isEnabled: () => true } as any,
    );
    const impact = new PriceImpactService({
      listOrders: jest.fn().mockResolvedValue({ data: book, meta: {} }),
    } as any);
    (svc as any).priceImpactService = impact;
    jest.spyOn(svc as any, 'fetchOrderFromLedger').mockImplementation(async (id: unknown) => book.find((o) => o.id === id));
    jest.spyOn(svc, 'getQuoteBalance').mockResolvedValue({ address: BUYER, asset: 'USDC', balance: '1000000' });
    jest.spyOn(svc, 'getOrder').mockImplementation(async (id: number) => book.find((o) => o.id === id)!);
    return { svc, invokeContractMethod };
  }

  it('normal path: buys the best ask', async () => {
    const { svc, invokeContractMethod } = build();
    await expect(svc.buyBondTokens({ orderId: 1, amount: 10, maxPrice: 100 }, BUYER)).resolves.toMatchObject({ transactionHash: 'tx' });
    expect(invokeContractMethod).toHaveBeenCalledTimes(1);
  });

  it('failure path: rejects the outlier ask with PRICE_IMPACT_EXCEEDED and makes no contract call', async () => {
    const { svc, invokeContractMethod } = build();
    const attempt = svc.buyBondTokens({ orderId: 2, amount: 10, maxPrice: 180 }, BUYER);
    await expect(attempt).rejects.toBeInstanceOf(ApiProblemException);
    await expect(attempt).rejects.toMatchObject({
      code: ErrorCode.PRICE_IMPACT_EXCEEDED,
      context: expect.objectContaining({ fillPremiumBps: 8000, bestOrderId: 1, targetOrderId: 2 }),
    });
    expect(invokeContractMethod).not.toHaveBeenCalled();
  });

  it('caller tolerance: a buyer can demand a tighter limit than the tier', async () => {
    const { svc, invokeContractMethod } = build();
    book.push(order(3, '105'));
    try {
      await expect(
        svc.buyBondTokens({ orderId: 3, amount: 10, maxPrice: 105, maxPriceImpactBps: 100 }, BUYER),
      ).rejects.toMatchObject({ context: expect.objectContaining({ limitSource: 'caller', maxAllowedImpactBps: 100 }) });
      expect(invokeContractMethod).not.toHaveBeenCalled();

      // Retry path: same order, tolerance that covers the 500 bps premium.
      await svc.buyBondTokens({ orderId: 3, amount: 10, maxPrice: 105, maxPriceImpactBps: 500 }, BUYER);
      expect(invokeContractMethod).toHaveBeenCalledTimes(1);
    } finally {
      book.pop();
    }
  });

  it('retry path: following bestOrderId from the rejection succeeds', async () => {
    const { svc, invokeContractMethod } = build();
    let bestOrderId: number | undefined;
    try {
      await svc.buyBondTokens({ orderId: 2, amount: 10, maxPrice: 180 }, BUYER);
    } catch (error) {
      bestOrderId = (error as ApiProblemException).context?.bestOrderId as number;
    }
    expect(bestOrderId).toBe(1);
    await svc.buyBondTokens({ orderId: bestOrderId!, amount: 10, maxPrice: 100 }, BUYER);
    expect(invokeContractMethod).toHaveBeenCalledTimes(1);
  });
});
