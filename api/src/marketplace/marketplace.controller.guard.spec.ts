import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { MarketplaceController } from './marketplace.controller';
import { DexService } from './dex.service';
import { LiquidityService } from './liquidity.service';
import { DexReconciliationService } from './dex.reconciliation.service';
import { StellarService } from '../stellar/stellar.service';
import { buildControllerApp } from '../test/controller-guard.harness';
import { autoMock, TestRole } from '../test/guard-role-mocks';

/**
 * The marketplace controller authenticates callers via the `x-wallet-address`
 * header rather than a JWT/KYC guard (see route-authorization.matrix.ts, role
 * `wallet-header`). These tests pin that model: mutations must reach the service
 * without a session, and the caller address must be sourced from the header.
 */
describe('MarketplaceController authorization (wallet-header model)', () => {
  let app: INestApplication;
  let dexService: jest.Mocked<DexService>;
  let liquidityService: jest.Mocked<LiquidityService>;
  let stellarService: jest.Mocked<StellarService>;

  const mockDexService = autoMock(DexService);
  const mockLiquidityService = autoMock(LiquidityService);
  const mockStellarService = autoMock(StellarService);

  beforeAll(async () => {
    app = await buildControllerApp(MarketplaceController, [
      { provide: DexService, useValue: mockDexService },
      { provide: LiquidityService, useValue: mockLiquidityService },
      { provide: DexReconciliationService, useValue: autoMock(DexReconciliationService) },
      { provide: StellarService, useValue: mockStellarService },
    ]);
    dexService = app.get(DexService) as jest.Mocked<DexService>;
    liquidityService = app.get(LiquidityService) as jest.Mocked<LiquidityService>;
    stellarService = app.get(StellarService) as jest.Mocked<StellarService>;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('wallet-header mutations reach the service without a JWT', () => {
    it('POST /marketplace/deposit passes the header address into the service', async () => {
      mockDexService.depositQuote.mockResolvedValue({ id: 'tx' } as any);
      await request(app.getHttpServer())
        .post('/marketplace/deposit')
        .set('x-test-role', 'anon' as TestRole)
        .set('x-wallet-address', 'G_SELLER')
        .send({ asset: 'USDC', amount: 10 })
        .expect(200);
      expect(dexService.depositQuote).toHaveBeenCalledWith(expect.anything(), 'G_SELLER');
    });

    it('POST /marketplace/buy uses the header buyer address', async () => {
      mockDexService.buyBondTokens.mockResolvedValue({ id: 'order' } as any);
      await request(app.getHttpServer())
        .post('/marketplace/buy')
        .set('x-test-role', 'anon' as TestRole)
        .set('x-wallet-address', 'G_BUYER')
        .send({ orderId: 1, amount: 5 })
        .expect(200);
      expect(dexService.buyBondTokens).toHaveBeenCalledWith(expect.anything(), 'G_BUYER');
    });

    it('DELETE /marketplace/orders/:id uses the header caller address', async () => {
      mockDexService.cancelOrder.mockResolvedValue(undefined as any);
      await request(app.getHttpServer())
        .delete('/marketplace/orders/7')
        .set('x-test-role', 'anon' as TestRole)
        .set('x-wallet-address', 'G_OWNER')
        .expect(204);
      expect(dexService.cancelOrder).toHaveBeenCalledWith(7, 'G_OWNER');
    });
  });

  describe('wallet-header reads', () => {
    it('GET /marketplace/quote-balance reads the header address', async () => {
      mockDexService.getQuoteBalance.mockResolvedValue({ address: 'G_OWNER', asset: 'USDC', balance: '0' } as any);
      await request(app.getHttpServer())
        .get('/marketplace/quote-balance')
        .set('x-test-role', 'anon' as TestRole)
        .set('x-wallet-address', 'G_OWNER')
        .expect(200);
      expect(dexService.getQuoteBalance).toHaveBeenCalledWith('G_OWNER', 'USDC');
    });
  });

  describe('public reads', () => {
    it('GET /marketplace/prices is reachable without a session', async () => {
      mockLiquidityService.getPriceFeed.mockResolvedValue([] as any);
      await request(app.getHttpServer())
        .get('/marketplace/prices')
        .set('x-test-role', 'anon' as TestRole)
        .expect(200);
      expect(liquidityService.getPriceFeed).toHaveBeenCalled();
    });
  });
});
