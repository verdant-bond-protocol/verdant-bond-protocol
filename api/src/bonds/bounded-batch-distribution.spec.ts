import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { BondsService } from './bonds.service';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { HolderIndexService } from './holder-index.service';
import { ConfigService } from '../config/config.service';
import { OracleService } from '../oracle/oracle.service';
import { ComplianceSnapshotService } from '../compliance/services/compliance-snapshot.service';
import { ReportStatus } from '../oracle/interfaces/oracle.interface';
import { nativeToScVal, xdr, Keypair } from '@stellar/stellar-sdk';

describe('Bounded Batch Processing for Large Holder Distributions (#456)', () => {
  let service: BondsService;
  let contractService: any;
  let holderIndexService: any;
  let oracleService: any;

  const validAdminKeypair = Keypair.random();

  beforeEach(async () => {
    const mockPeriodInfoScVal = xdr.ScVal.scvVec([
      nativeToScVal(0, { type: 'u32' }),
      nativeToScVal(BigInt(1000), { type: 'u64' }),
      nativeToScVal(BigInt(2000), { type: 'u64' }),
      nativeToScVal(BigInt(100), { type: 'i128' }),
      nativeToScVal(false, { type: 'bool' }),
      nativeToScVal(BigInt(7), { type: 'u64' }),
      nativeToScVal(BigInt(0), { type: 'i128' }),
    ]);

    const mockBatchResultScVal = xdr.ScVal.scvVec([
      nativeToScVal(0, { type: 'u32' }),
      nativeToScVal(0, { type: 'u32' }),
      nativeToScVal(BigInt(100), { type: 'i128' }),
      nativeToScVal(50, { type: 'u32' }),
    ]);

    contractService = {
      simulateCall: jest.fn().mockResolvedValue(mockPeriodInfoScVal),
      invokeContractMethod: jest.fn().mockResolvedValue({
        result: mockBatchResultScVal,
        transactionHash: 'tx-batch-hash-1',
      }),
    };

    holderIndexService = {
      getHoldersForCoupon: jest.fn(),
    };

    oracleService = {
      getReport: jest.fn().mockResolvedValue({
        id: 7,
        status: ReportStatus.Verified,
        carbonSequestered: '100000',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BondsService,
        { provide: ContractService, useValue: contractService },
        { provide: HolderIndexService, useValue: holderIndexService },
        { provide: OracleService, useValue: oracleService },
        {
          provide: StellarService,
          useValue: {
            getKeypairFromSecret: jest.fn().mockReturnValue(validAdminKeypair),
          },
        },
        {
          provide: NonceService,
          useValue: {
            next: jest.fn().mockResolvedValue(1),
          },
        },
        {
          provide: RedisService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue('OK'),
            setEx: jest.fn().mockResolvedValue('OK'),
            del: jest.fn().mockResolvedValue(1),
          },
        },
        {
          provide: SigningKeyProvider,
          useValue: {
            adminSecret: () => validAdminKeypair.secret(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getCouponEngineAddress: () => 'CC67TYNGECOUPONENGINEADDRESS1111111111111111111111111111',
            getBondIssuerAddress: () => 'CC67TYNGEBONDISSUERADDRESS1111111111111111111111111111',
          },
        },
        {
          provide: ComplianceSnapshotService,
          useValue: {
            capture: jest.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compile();

    service = module.get<BondsService>(BondsService);
  });

  it('normal path: executes single bounded batch for a subset of holders', async () => {
    const mockHolders = Array.from({ length: 30 }, () => Keypair.random().publicKey());
    holderIndexService.getHoldersForCoupon.mockResolvedValue(mockHolders);

    const result = await service.distributeCouponBatch(1, {
      periodIndex: 0,
      reportId: 7,
      offset: 0,
      limit: 30,
    });

    expect(result.bondId).toBe(1);
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(30);
    expect(result.cursor).toBe(30);
    expect(result.batchComplete).toBe(true);
    expect(contractService.invokeContractMethod).toHaveBeenCalledWith(
      expect.any(String),
      'distribute_coupon_batch',
      expect.any(String),
      expect.any(Array),
      expect.any(String),
    );
  });

  it('large holder path: automatically chunks large holder lists (>50) into bounded batches', async () => {
    const mockHolders = Array.from({ length: 120 }, () => Keypair.random().publicKey());
    holderIndexService.getHoldersForCoupon.mockResolvedValue(mockHolders);

    const result = await service.distributeCoupon(1, { periodIndex: 0, reportId: 7 });

    expect(result.bondId).toBe(1);
    expect(result.holderCount).toBe(120);
    expect(contractService.invokeContractMethod).toHaveBeenCalledTimes(3);
  });

  it('failure path: rejects batch limit greater than maximum bound (100)', async () => {
    holderIndexService.getHoldersForCoupon.mockResolvedValue([]);

    await expect(
      service.distributeCouponBatch(1, {
        periodIndex: 0,
        reportId: 7,
        offset: 0,
        limit: 150,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('failure path: rejects distribution when oracle report is challenged', async () => {
    oracleService.getReport.mockResolvedValue({
      id: 7,
      status: ReportStatus.Challenged,
    });
    holderIndexService.getHoldersForCoupon.mockResolvedValue([Keypair.random().publicKey()]);

    await expect(
      service.distributeCouponBatch(1, {
        periodIndex: 0,
        reportId: 7,
        offset: 0,
        limit: 1,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('status path: correctly queries on-chain cursor and remaining holder progress', async () => {
    const mockHolders = Array.from({ length: 80 }, (_, i) => `GHOLDER${i}`);
    holderIndexService.getHoldersForCoupon.mockResolvedValue(mockHolders);

    const status = await service.getCouponBatchStatus(1, 0);

    expect(status.bondId).toBe(1);
    expect(status.totalHolders).toBe(80);
    expect(status.distributed).toBe(false);
  });
});
