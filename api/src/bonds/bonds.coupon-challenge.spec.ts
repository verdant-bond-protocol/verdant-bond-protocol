import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Keypair, nativeToScVal } from '@stellar/stellar-sdk';
import { BondsService } from './bonds.service';
import { OracleService } from '../oracle/oracle.service';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { ConfigService } from '../config/config.service';
import { HolderIndexService } from './holder-index.service';
import { ReportStatus } from '../oracle/interfaces/oracle.interface';
import { xdr } from '@stellar/stellar-sdk';

const validCouponResult = xdr.ScVal.scvVec([
  nativeToScVal(BigInt(1), { type: 'u64' }),
  xdr.ScVal.scvU32(0),
  nativeToScVal(BigInt(0), { type: 'i128' }),
  xdr.ScVal.scvU32(1),
]);

function bondsModuleWith(oracleService?: any) {
  const providers: any[] = [
    BondsService,

    {
      provide: ContractService,
      useValue: { invokeContractMethod: jest.fn().mockResolvedValue({ result: validCouponResult, transactionHash: 'x' }), simulateCall: jest.fn() },
    },
    {
      provide: StellarService,
      useValue: { getKeypairFromSecret: jest.fn().mockReturnValue({ publicKey: () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' }) },
    },
    { provide: NonceService, useValue: { next: jest.fn().mockResolvedValue(0) } },
    {
      provide: RedisService,
      useValue: { sMembers: jest.fn().mockResolvedValue([]), get: jest.fn(), setEx: jest.fn(), del: jest.fn(), sAdd: jest.fn() },
    },
    {
      provide: SigningKeyProvider,
      useValue: { adminSecret: jest.fn().mockReturnValue('SADMIN'), investorSecret: jest.fn().mockReturnValue('S') },
    },
    {
      provide: ConfigService,
      useValue: { getCouponEngineAddress: jest.fn().mockReturnValue('C'), getBondIssuerAddress: jest.fn().mockReturnValue('B') },
    },
    {
      provide: HolderIndexService,
      useValue: { getHoldersForCoupon: jest.fn().mockResolvedValue([]), getHoldersWithBalances: jest.fn().mockResolvedValue([]) },
    },
  ];
  if (oracleService) {
    providers.push({ provide: OracleService, useValue: oracleService });
  }
  return Test.createTestingModule({ providers }).compile();
}

describe('BondsService coupon challenge linkage (#oracle-challenge)', () => {
  const oracleService = { getReport: jest.fn() };

  it('blocks coupon distribution when the referenced report is Challenged', async () => {
    oracleService.getReport.mockResolvedValue({ id: 7, status: ReportStatus.Challenged });
    const moduleRef = await bondsModuleWith(oracleService);
    const service = moduleRef.get(BondsService);
    await expect(service.distributeCoupon(1, { periodIndex: 0, reportId: 7 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('blocks coupon distribution when the referenced report is Rejected', async () => {
    oracleService.getReport.mockResolvedValue({ id: 7, status: ReportStatus.Rejected });
    const moduleRef = await bondsModuleWith(oracleService);
    const service = moduleRef.get(BondsService);
    await expect(service.distributeCoupon(1, { periodIndex: 0, reportId: 7 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('allows coupon distribution when the referenced report is Verified', async () => {
    oracleService.getReport.mockResolvedValue({ id: 7, status: ReportStatus.Verified });
    const moduleRef = await bondsModuleWith(oracleService);
    const service = moduleRef.get(BondsService);
    const result = await service.distributeCoupon(1, { periodIndex: 0, reportId: 7 });
    expect(result.bondId).toBe(1);
  });

  it('remains backward compatible when no oracle service is wired in', async () => {
    const moduleRef = await bondsModuleWith(undefined);
    const service = moduleRef.get(BondsService);
    const result = await service.distributeCoupon(1, { periodIndex: 0, reportId: 7 });
    expect(result.bondId).toBe(1);
  });
});
