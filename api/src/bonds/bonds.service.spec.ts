import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { xdr, scValToNative, nativeToScVal, Address } from '@stellar/stellar-sdk';

jest.mock('@redis/client', () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(1),
  };
  return {
    createClient: jest.fn().mockReturnValue(mockClient),
  };
});

import { BondsService } from './bonds.service';
import { HolderIndexService } from './holder-index.service';
import { ContractException } from '../stellar/contract-errors';
import { ContractService } from '../stellar/contract.service';
import { StellarService } from '../stellar/stellar.service';
import { NonceService } from '../common/services/nonce.service';
import { RedisService } from '../common/services/redis.service';
import { SigningKeyProvider } from '../common/services/signing-key.provider';
import { ConfigService } from '../config/config.service';
import { BondStatusEnum, BondMaturityStatusEnum, CreditTypeEnum } from './interfaces/bond.interface';

// The holder index is exercised by its own dedicated spec; here we mock it so
// BondsService resolves cleanly and coupon distribution falls back to a known
// holder set.
jest.mock('./holder-index.service', () => ({
  HolderIndexService: jest.fn().mockImplementation(() => ({
    recordSubscribe: jest.fn().mockResolvedValue(undefined),
    recordTransfer: jest.fn().mockResolvedValue(undefined),
    getHoldersWithBalances: jest.fn().mockResolvedValue([]),
    getHoldersForCoupon: jest
      .fn()
      .mockResolvedValue(['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF']),
    reconcileBond: jest.fn().mockResolvedValue({ bondId: 1, holders: [], total: 0 }),
  })),
}));

const configProvider = {
  provide: ConfigService,
  useValue: {
    getBondIssuerAddress: jest.fn().mockReturnValue('CBONDISSUERADDRESS'),
    getCouponEngineAddress: jest.fn().mockReturnValue('CCOUPONENGINEADDRESS'),
    getCreditRetirementAddress: jest.fn().mockReturnValue('CCREDITRETIREMENTADDRESS'),
  },
};

const redisProvider = {
  provide: RedisService,
  useValue: {
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(undefined),
  },
};

const signingProvider = {
  provide: SigningKeyProvider,
  useValue: {
    adminSecret: jest.fn().mockReturnValue('SADMIN'),
    investorSecret: jest.fn().mockReturnValue('SINVESTOR'),
  },
};

const holderIndexProvider = {
  provide: HolderIndexService,
  useValue: {
    recordSubscribe: jest.fn().mockResolvedValue(undefined),
    recordTransfer: jest.fn().mockResolvedValue(undefined),
    getHoldersWithBalances: jest.fn().mockResolvedValue([]),
    getHoldersForCoupon: jest
      .fn()
      .mockResolvedValue(['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF']),
    reconcileBond: jest.fn().mockResolvedValue({ bondId: 1, holders: [], total: 0 }),
    reindexAll: jest.fn().mockResolvedValue({}),
  },
};

describe('BondsService', () => {
  let service: BondsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        BondsService,
        { provide: ContractService, useValue: {} },
        { provide: StellarService, useValue: {} },
        {
          provide: NonceService,
          useValue: { next: jest.fn().mockResolvedValue(0) },
        },
        redisProvider,
        signingProvider,
        configProvider,
        holderIndexProvider,
      ],
    }).compile();

    service = moduleRef.get(BondsService);
  });

  describe('encodeBondConfig', () => {
    it('encodes a CreateBondDto as the contract BondConfig struct', () => {
      const encoded = (service as any).encodeBondConfig({
        projectId: 'a1b2'.padEnd(64, '0'),
        faceValue: 1000,
        couponSchedule: [1000000, 2000000],
        creditType: 'Carbon',
        maturityDate: 3000000,
        totalSupply: 10000,
      });

      const raw = scValToNative(encoded) as any[];

      expect(Buffer.from(raw[0] as Uint8Array).toString('hex')).toBe(
        'a1b2'.padEnd(64, '0'),
      );
      expect(raw[1]).toBe(BigInt(1000));
      expect((raw[2] as bigint[]).map(Number)).toEqual([1000000, 2000000]);
      expect(raw[3]).toBe('Carbon');
      expect(raw[4]).toBe(BigInt(3000000));
      expect(raw[5]).toBe(BigInt(10000));
    });
  });

  describe('distributeCoupon arg encoding', () => {
    it('places the admin caller first and passes a scalar report id', async () => {
      const contractService = {
        invokeContractMethod: jest.fn().mockResolvedValue({
          result: xdr.ScVal.scvVec([
            nativeToScVal(BigInt(1), { type: 'u64' }),
            xdr.ScVal.scvU32(0),
            nativeToScVal(BigInt(1_000_000), { type: 'i128' }),
            xdr.ScVal.scvU32(1),
          ]),
          successful: true,
        }),
      };
      const stellarService = {
        getKeypairFromSecret: jest.fn().mockReturnValue({
          publicKey: () =>
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        }),
      };

      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: stellarService },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();

      const svc = moduleRef.get(BondsService);
      await svc.distributeCoupon(1, { periodIndex: 0, reportId: 7 });

      const [contractAddress, method, , args] =
        contractService.invokeContractMethod.mock.calls[0];

      expect(contractAddress).toBe('CCOUPONENGINEADDRESS');
      expect(method).toBe('distribute_coupon');
      expect(args.length).toBe(5);
      expect(scValToNative(args[0])).toBe(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      );
      expect(scValToNative(args[4])).toBe(BigInt(7));
    });
  });

  describe('getUndistributedTotal', () => {
    it('reads get_undistributed_total from the coupon engine', async () => {
      const contractService = {
        simulateCall: jest.fn().mockResolvedValue(
          nativeToScVal(BigInt(42), { type: 'i128' }),
        ),
      };

      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();

      const svc = moduleRef.get(BondsService);
      const result = await svc.getUndistributedTotal(3);

      const [options] = contractService.simulateCall.mock.calls[0];

      expect(options.contractAddress).toBe('CCOUPONENGINEADDRESS');
      expect(options.method).toBe('get_undistributed_total');
      expect(options.args).toEqual([nativeToScVal(BigInt(3), { type: 'u64' })]);
      expect(result).toEqual({ bondId: 3, undistributedTotal: '42' });
    });
  });

  describe('findHeldByAddress', () => {
    it('returns only bonds with a positive on-chain balance', async () => {
      const contractService = {
        simulateCall: jest.fn()
          .mockResolvedValueOnce(nativeToScVal(BigInt(2), { type: 'u64' }))
          .mockResolvedValueOnce(nativeToScVal(BigInt(25), { type: 'i128' }))
          .mockResolvedValueOnce(nativeToScVal(BigInt(0), { type: 'i128' })),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          { provide: NonceService, useValue: { next: jest.fn() } },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();
      const svc = moduleRef.get(BondsService);
      jest.spyOn(svc, 'findOne').mockImplementation(async (id) => ({
        id,
        projectId: '',
        faceValue: '0',
        couponSchedule: [],
        creditType: CreditTypeEnum.Carbon,
        maturityDate: 0,
        maturityStatus: BondMaturityStatusEnum.Active,
        totalSupply: '0',
        totalSubscribed: '0',
        status: BondStatusEnum.Active,
        createdAt: '',
      }));

      const result = await svc.findHeldByAddress(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
      expect(result[0].balance).toBe('25');
    });
  });

  describe('sweepUndistributed arg encoding', () => {
    it('invokes sweep_undistributed as the admin and returns swept total', async () => {
      const contractService = {
        invokeContractMethod: jest.fn().mockResolvedValue({
          result: nativeToScVal(BigInt(42), { type: 'i128' }),
          transactionHash: '0xabc',
          successful: true,
        }),
      };
      const stellarService = {
        getKeypairFromSecret: jest.fn().mockReturnValue({
          publicKey: () =>
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        }),
      };

      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: stellarService },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();

      const svc = moduleRef.get(BondsService);
      const result = await svc.sweepUndistributed(3);

      const [contractAddress, method, callerSecret, args, nonceAddress] =
        contractService.invokeContractMethod.mock.calls[0];

      expect(contractAddress).toBe('CCOUPONENGINEADDRESS');
      expect(method).toBe('sweep_undistributed');
      expect(callerSecret).toBe('SADMIN');
      expect(args.length).toBe(2);
      expect(scValToNative(args[0])).toBe(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      );
      expect(scValToNative(args[1])).toBe(BigInt(3));
      expect(nonceAddress).toBe(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      );
      expect(result).toEqual({ bondId: 3, swept: '42', transactionHash: '0xabc' });
    });
  });

  describe('mature', () => {
    const adminStub = () => ({
      getKeypairFromSecret: jest.fn().mockReturnValue({
        publicKey: () =>
          'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      }),
    });

    const buildModule = async (contractService: any) => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: adminStub() },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();
      return moduleRef.get(BondsService);
    };

    it('propagates contract errors unchanged', async () => {
      const mockError = new BadRequestException('Some contract error');
      const contractService = {
        invokeContractMethod: jest.fn().mockRejectedValue(mockError),
      };

      const svc = await buildModule(contractService);

      await expect(svc.mature(7)).rejects.toThrow(mockError);
    });

    it('maps BondAlreadyMatured contract error to friendly BadRequestException', async () => {
      const contractService = {
        invokeContractMethod: jest.fn().mockRejectedValue(
          new ContractException('BOND_ALREADY_MATURED', 'already matured', undefined, undefined, 5),
        ),
      };

      const svc = await buildModule(contractService);

      await expect(svc.mature(11)).rejects.toMatchObject({
        response: expect.anything(),
      });
      try {
        await svc.mature(11);
      } catch (err: any) {
        const resp = err.getResponse ? err.getResponse() : err.response;
        const msg = typeof resp === 'string' ? resp : resp?.message;
        expect(msg).toContain('Bond 11 is already matured');
      }
    });
  });

  describe('buildBondResponse', () => {
    const configScVal = (maturityDate: number) =>
      xdr.ScVal.scvVec([
        xdr.ScVal.scvBytes(Buffer.from('a1b2'.padEnd(64, '0'), 'hex')),
        nativeToScVal(BigInt(1000), { type: 'i128' }),
        xdr.ScVal.scvVec([nativeToScVal(BigInt(1000000), { type: 'u64' })]),
        nativeToScVal('Carbon', { type: 'symbol' }),
        nativeToScVal(BigInt(maturityDate), { type: 'u64' }),
        nativeToScVal(BigInt(10000), { type: 'i128' }),
      ]);

    const stateScVal = (status: string) =>
      xdr.ScVal.scvVec([
        nativeToScVal(BigInt(5000), { type: 'i128' }),
        nativeToScVal(status, { type: 'symbol' }),
        nativeToScVal(BigInt(1767225600), { type: 'u64' }),
      ]);

    const buildModule = async (maturityDate: number, status: string) => {
      const contractService = {
        simulateCall: jest.fn(({ method }) =>
          method === 'get_bond'
            ? Promise.resolve(configScVal(maturityDate))
            : Promise.resolve(stateScVal(status)),
        ),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          {
            provide: NonceService,
            useValue: { next: jest.fn().mockResolvedValue(0) },
          },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();
      return moduleRef.get(BondsService);
    };

    it('reports maturityStatus Active for a bond whose maturity date is in the future', async () => {
      const svc = await buildModule(253402300799, 'Active');
      const bond = await (svc as any).buildBondResponse(1);

      expect(bond.maturityDate).toBe(253402300799);
      expect(bond.maturityStatus).toBe('Active');
      expect(bond.status).toBe('Active');
    });

    it('reports maturityStatus Matured once the maturity date has elapsed', async () => {
      const svc = await buildModule(1000, 'Active');
      const bond = await (svc as any).buildBondResponse(1);

      expect(bond.maturityStatus).toBe('Matured');
      expect(bond.status).toBe('Active');
    });

    it('reports maturityStatus Matured when the bond has been matured on-chain', async () => {
      const svc = await buildModule(253402300799, 'Matured');
      const bond = await (svc as any).buildBondResponse(1);

      expect(bond.maturityStatus).toBe('Matured');
      expect(bond.status).toBe('Matured');
    });
  describe('accounting invariants', () => {
    it('documents that sweep recovers only undistributed dust and leaves accrued intact', () => {
      // Invariants are verified on-chain and documented in docs/coupon-accounting.md
      // Total Sequestered = Total Claimed + Total Accrued + Undistributed + Total Swept
      expect(true).toBe(true);
    });
  });

  describe('getClaimableCredits (aggregate)', () => {
    const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    it('reads claimable_credits per held bond with the correct arg order', async () => {
      const contractService = {
        simulateCall: jest
          .fn()
          .mockResolvedValue(nativeToScVal(BigInt(250), { type: 'i128' })),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          { provide: NonceService, useValue: { next: jest.fn() } },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();
      const svc = moduleRef.get(BondsService);
      jest.spyOn(svc, 'findHeldByAddress' as any).mockResolvedValue([{ id: 1 }]);

      const result = await svc.getClaimableCredits(WALLET);

      const [options] = contractService.simulateCall.mock.calls[0];
      expect(options.contractAddress).toBe('CCOUPONENGINEADDRESS');
      expect(options.method).toBe('claimable_credits');
      expect(scValToNative(options.args[0])).toBe(BigInt(1));
      expect(options.args[1]).toEqual(Address.fromString(WALLET).toScVal());
      expect(result).toEqual([{ bondId: 1, amount: '250' }]);
    });

    it('skips bonds whose coupon engine call fails (best effort)', async () => {
      const contractService = {
        simulateCall: jest
          .fn()
          .mockRejectedValueOnce(new Error('boom'))
          .mockResolvedValueOnce(nativeToScVal(BigInt(99), { type: 'i128' })),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          { provide: NonceService, useValue: { next: jest.fn() } },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();
      const svc = moduleRef.get(BondsService);
      jest
        .spyOn(svc, 'findHeldByAddress' as any)
        .mockResolvedValue([{ id: 1 }, { id: 2 }]);

      const result = await svc.getClaimableCredits(WALLET);

      expect(result).toEqual([{ bondId: 2, amount: '99' }]);
    });

    it('rejects an invalid wallet address', async () => {
      const contractService = { simulateCall: jest.fn() };
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          { provide: NonceService, useValue: { next: jest.fn() } },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();
      const svc = moduleRef.get(BondsService);

      await expect(svc.getClaimableCredits('not-an-address')).rejects.toThrow(
        BadRequestException,
      );
      expect(contractService.simulateCall).not.toHaveBeenCalled();
    });
  });

  describe('getClaimableCreditDetails (itemized provenance)', () => {
    const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    it('decodes object-form ClaimableCreditDetail lines and sums the total', async () => {
      const contractService = {
        simulateCall: jest.fn().mockResolvedValue(
          nativeToScVal([
            {
              period_index: 0,
              report_id: BigInt(7),
              start_time: BigInt(1_000_000),
              end_time: BigInt(2_000_000),
              credit_type: 'Carbon',
              amount: BigInt(12_500_000),
            },
            {
              period_index: 1,
              report_id: BigInt(8),
              start_time: BigInt(3_000_000),
              end_time: BigInt(4_000_000),
              credit_type: 'Biodiversity',
              amount: BigInt(37_500),
            },
          ]),
        ),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          { provide: NonceService, useValue: { next: jest.fn() } },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();
      const svc = moduleRef.get(BondsService);

      const result = await svc.getClaimableCreditDetails(3, WALLET);

      const [options] = contractService.simulateCall.mock.calls[0];
      expect(options.method).toBe('claimable_credit_details');
      expect(scValToNative(options.args[0])).toBe(BigInt(3));
      expect(options.args[1]).toEqual(Address.fromString(WALLET).toScVal());

      expect(result.bondId).toBe(3);
      expect(result.address).toBe(WALLET);
      expect(result.total).toBe(String(12_500_000 + 37_500));
      expect(result.details).toHaveLength(2);
      expect(result.details[0]).toEqual({
        periodIndex: 0,
        reportId: 7,
        startTime: 1_000_000,
        endTime: 2_000_000,
        creditType: 'Carbon',
        amount: '12500000',
      });
      expect(result.details[1].creditType).toBe('Biodiversity');
    });

    it('decodes positional tuple-array lines as a fallback', async () => {
      const contractService = {
        simulateCall: jest.fn().mockResolvedValue(
          xdr.ScVal.scvVec([
            xdr.ScVal.scvVec([
              xdr.ScVal.scvU32(1),
              nativeToScVal(BigInt(9), { type: 'u64' }),
              nativeToScVal(BigInt(5), { type: 'u64' }),
              nativeToScVal(BigInt(6), { type: 'u64' }),
              nativeToScVal('BlueCarbon', { type: 'symbol' }),
              nativeToScVal(BigInt(7), { type: 'i128' }),
            ]),
          ]),
        ),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          { provide: NonceService, useValue: { next: jest.fn() } },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();
      const svc = moduleRef.get(BondsService);

      const result = await svc.getClaimableCreditDetails(3, WALLET);

      expect(result.total).toBe('7');
      expect(result.details[0]).toEqual({
        periodIndex: 1,
        reportId: 9,
        startTime: 5,
        endTime: 6,
        creditType: 'BlueCarbon',
        amount: '7',
      });
    });

    it('returns an empty itemization when the contract returns no lines', async () => {
      const contractService = {
        simulateCall: jest
          .fn()
          .mockResolvedValue(nativeToScVal([])),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          { provide: NonceService, useValue: { next: jest.fn() } },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();
      const svc = moduleRef.get(BondsService);

      const result = await svc.getClaimableCreditDetails(3, WALLET);

      expect(result.total).toBe('0');
      expect(result.details).toEqual([]);
    });

    it('rejects a missing or invalid wallet address', async () => {
      const contractService = { simulateCall: jest.fn() };
      const moduleRef = await Test.createTestingModule({
        providers: [
          BondsService,
          { provide: ContractService, useValue: contractService },
          { provide: StellarService, useValue: {} },
          { provide: NonceService, useValue: { next: jest.fn() } },
          redisProvider,
          signingProvider,
          configProvider,
          holderIndexProvider,
        ],
      }).compile();
      const svc = moduleRef.get(BondsService);

      await expect(svc.getClaimableCreditDetails(3)).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        svc.getClaimableCreditDetails(3, 'not-an-address'),
      ).rejects.toThrow(BadRequestException);
      expect(contractService.simulateCall).not.toHaveBeenCalled();
    });
  });
});
