import { Test, TestingModule } from '@nestjs/testing';
import { StellarService } from './stellar.service';
import { HttpException, HttpStatus } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';

describe('StellarService', () => {
  let service: StellarService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StellarService],
    }).compile();

    service = module.get<StellarService>(StellarService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getBalance', () => {
    const mockAccountWithUSDC = {
      balances: [
        { asset_type: 'native', balance: '100.50' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'G_USDC_ISSUER', balance: '500.00' },
        { asset_type: 'credit_alphanum12', asset_code: 'LONGTOKEN', asset_issuer: 'G_LONG_ISSUER', balance: '10.00' },
      ],
    } as Horizon.AccountResponse;

    const mockAccountNoUSDC = {
      balances: [
        { asset_type: 'native', balance: '100.50' },
      ],
    } as Horizon.AccountResponse;

    it('returns the native XLM balance when assetCode is missing or XLM', async () => {
      jest.spyOn(service, 'getAccount').mockResolvedValue(mockAccountWithUSDC);
      
      const balance = await service.getBalance('G_TEST');
      expect(balance).toBe('100.50');

      const balanceXLM = await service.getBalance('G_TEST', 'XLM');
      expect(balanceXLM).toBe('100.50');
    });

    it('returns the correct balance for a non-native asset that exists on the account', async () => {
      jest.spyOn(service, 'getAccount').mockResolvedValue(mockAccountWithUSDC);
      
      const usdcBalance = await service.getBalance('G_TEST', 'USDC');
      expect(usdcBalance).toBe('500.00');

      const longTokenBalance = await service.getBalance('G_TEST', 'LONGTOKEN', 'G_LONG_ISSUER');
      expect(longTokenBalance).toBe('10.00');
    });

    it('returns 0 when the account does not have a trustline for the queried non-native asset', async () => {
      jest.spyOn(service, 'getAccount').mockResolvedValue(mockAccountNoUSDC);
      
      const usdcBalance = await service.getBalance('G_TEST', 'USDC');
      expect(usdcBalance).toBe('0');
    });

    it('throws HttpException if the account is not found', async () => {
      jest.spyOn(service, 'getAccount').mockRejectedValue(
        new HttpException('Failed to load account', HttpStatus.NOT_FOUND)
      );
      
      await expect(service.getBalance('G_NOT_FOUND', 'USDC')).rejects.toThrow(HttpException);
    });
  });
});
