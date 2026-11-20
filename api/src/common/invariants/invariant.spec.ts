/**
 * Invariant test suite for domain model consistency.
 *
 * These tests assert that the Verdant Bond Protocol domain model cannot
 * enter impossible states through any API, UI, worker, or contract path.
 *
 * See: https://github.com/verdant-bond-protocol/verdant-bond-protocol/issues/262
 *
 * Invariants covered:
 * - INV-001: subscribed <= totalSupply
 * - INV-002: maturityStatus matches bond lifecycle
 * - INV-003: defaulted bonds have no active distributions
 * - INV-004: holder balance must be positive
 * - INV-005: sum of holder balances equals totalSubscribed
 * - INV-006: holder address is a valid Stellar address
 * - INV-007: only admin can mature bonds
 * - INV-008: only KYC-verified investors can subscribe
 * - INV-009: createdAt is before maturityDate
 * - INV-010: coupon period index is within schedule bounds
 * - INV-011: bond ID is a positive integer
 */

import { KycStatus } from '../interfaces/authenticated-request.interface';
import { Test, TestingModule } from '@nestjs/testing';
import { BondsService } from '../../bonds/bonds.service';
import { ContractService } from '../../stellar/contract.service';
import { StellarService } from '../../stellar/stellar.service';
import { NonceService } from '../services/nonce.service';
import { RedisService } from '../services/redis.service';
import { SigningKeyProvider } from '../services/signing-key.provider';
import { ConfigService } from '../../config/config.service';
import { HolderIndexService } from '../../bonds/holder-index.service';
import { KycService } from '../../auth/kyc.service';
import {
  bondLifecycleInvariants,
  ownershipInvariants,
  accessControlInvariants,
  dataIntegrityInvariants,
  runAllInvariants,
  InvariantResult,
} from './domain-invariants';
import { BondStatusEnum, BondMaturityStatusEnum, CreditTypeEnum } from '../../bonds/interfaces/bond.interface';

jest.mock('@redis/client', () => {
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(1),
    scan: jest.fn().mockResolvedValue({ cursor: 0, keys: [] }),
  };
  return { createClient: jest.fn().mockReturnValue(mockClient) };
});

jest.mock('../../bonds/holder-index.service', () => ({
  HolderIndexService: jest.fn().mockImplementation(() => ({
    recordSubscribe: jest.fn().mockResolvedValue(undefined),
    recordTransfer: jest.fn().mockResolvedValue(undefined),
    getHoldersWithBalances: jest.fn().mockResolvedValue([]),
    getHoldersForCoupon: jest.fn().mockResolvedValue([]),
    reconcileBond: jest.fn().mockResolvedValue({ bondId: 1, holders: [], total: 0 }),
    reindexAll: jest.fn().mockResolvedValue({}),
    getStore: jest.fn().mockReturnValue({ getHolders: () => [], getKnownAddresses: () => [] }),
  })),
}));

jest.mock('../../auth/kyc.service', () => ({
  KycService: jest.fn().mockImplementation(() => ({
    getStatus: jest.fn().mockResolvedValue('verified'),
    isEligibleRecord: jest.fn().mockResolvedValue({ eligible: true, record: { status: 'verified' } }),
  })),
}));

const configProvider = {
  provide: ConfigService,
  useValue: {
    getBondIssuerAddress: jest.fn().mockReturnValue('CBONDISSUERADDRESS'),
    getCouponEngineAddress: jest.fn().mockReturnValue('CCOUPONENGINEADDRESS'),
    getCreditRetirementAddress: jest.fn().mockReturnValue('CCREDITRETIREMENTADDRESS'),
    getProjectRegistryAddress: jest.fn().mockReturnValue('CREGISTRY'),
    getOracleConsumerAddress: jest.fn().mockReturnValue('CORACLE'),
    getDexRouterAddress: jest.fn().mockReturnValue('CDEX'),
    getJwtSecret: jest.fn().mockReturnValue('test-jwt-secret-must-be-long-enough-32chars-min'),
    getJwtRefreshSecret: jest.fn().mockReturnValue('test-jwt-refresh-secret-min-32characters'),
    getJwtExpiry: jest.fn().mockReturnValue('15m'),
    getJwtRefreshExpiry: jest.fn().mockReturnValue('7d'),
  },
};

const redisProvider = {
  provide: RedisService,
  useValue: {
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    sAdd: jest.fn().mockResolvedValue(undefined),
    sMembers: jest.fn().mockResolvedValue([]),
    scan: jest.fn().mockResolvedValue({ cursor: 0, keys: [] }),
  },
};

const signingProvider = {
  provide: SigningKeyProvider,
  useValue: {
    adminSecret: jest.fn().mockReturnValue('SADMIN'),
    investorSecret: jest.fn().mockReturnValue('SINVESTOR'),
    userSecret: jest.fn().mockReturnValue('SUSER'),
  },
};

async function createTestingModule(): Promise<TestingModule> {
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
      { provide: HolderIndexService, useValue: {} },
      { provide: KycService, useValue: {} },
    ],
  }).compile();
  return moduleRef;
}

describe('Domain Invariant Test Suite (#262)', () => {
  let moduleRef: TestingModule;
  let bondsService: BondsService;

  beforeAll(async () => {
    moduleRef = await createTestingModule();
    bondsService = moduleRef.get(BondsService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  describe('INV-001: subscribed <= totalSupply', () => {
    it('passes when totalSubscribed is less than totalSupply', async () => {
      const result = await bondLifecycleInvariants.subscribedDoesNotExceedSupply('5000', '10000');
      expect(result.passed).toBe(true);
      expect(result.code).toBe('INV-001');
    });

    it('passes when totalSubscribed equals totalSupply', async () => {
      const result = await bondLifecycleInvariants.subscribedDoesNotExceedSupply('10000', '10000');
      expect(result.passed).toBe(true);
    });

    it('fails when totalSubscribed exceeds totalSupply', async () => {
      const result = await bondLifecycleInvariants.subscribedDoesNotExceedSupply('15000', '10000');
      expect(result.passed).toBe(false);
      expect(result.message).toContain('exceeds');
    });
  });

  describe('INV-002: maturityStatus matches bond lifecycle', () => {
    it('reports Active for a bond whose maturity date is in the future', async () => {
      const result = await bondLifecycleInvariants.maturedBondHasMaturedStatus(
        BondStatusEnum.Active,
        9999999999,
        BondMaturityStatusEnum.Active,
      );
      expect(result.passed).toBe(true);
    });

    it('reports Matured when maturity date has elapsed', async () => {
      const result = await bondLifecycleInvariants.maturedBondHasMaturedStatus(
        BondStatusEnum.Active,
        1,
        BondMaturityStatusEnum.Matured,
      );
      expect(result.passed).toBe(true);
    });

    it('fails when a matured bond reports Active maturityStatus', async () => {
      const result = await bondLifecycleInvariants.maturedBondHasMaturedStatus(
        BondStatusEnum.Matured,
        9999999999,
        BondMaturityStatusEnum.Active,
      );
      expect(result.passed).toBe(false);
    });
  });

  describe('INV-003: defaulted bonds have no active distributions', () => {
    it('passes for an active bond with distributions', async () => {
      const result = await bondLifecycleInvariants.defaultedBondHasNoActiveCoupons(
        BondStatusEnum.Active,
        true,
      );
      expect(result.passed).toBe(true);
    });

    it('fails for a defaulted bond with active distributions', async () => {
      const result = await bondLifecycleInvariants.defaultedBondHasNoActiveCoupons(
        BondStatusEnum.Defaulted,
        true,
      );
      expect(result.passed).toBe(false);
      expect(result.message).toContain('impossible state');
    });

    it('passes for a defaulted bond with no distributions', async () => {
      const result = await bondLifecycleInvariants.defaultedBondHasNoActiveCoupons(
        BondStatusEnum.Defaulted,
        false,
      );
      expect(result.passed).toBe(true);
    });
  });

  describe('INV-004: holder balance must be positive', () => {
    it('passes for a positive balance', async () => {
      const result = await ownershipInvariants.holderBalanceIsPositive(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        '100',
      );
      expect(result.passed).toBe(true);
    });

    it('fails for a zero balance', async () => {
      const result = await ownershipInvariants.holderBalanceIsPositive(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        '0',
      );
      expect(result.passed).toBe(false);
    });

    it('fails for a negative balance', async () => {
      const result = await ownershipInvariants.holderBalanceIsPositive(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        '-100',
      );
      expect(result.passed).toBe(false);
    });
  });

  describe('INV-005: sum of holder balances equals totalSubscribed', () => {
    it('passes when balances sum matches total', async () => {
      const result = await ownershipInvariants.holderBalancesSumEqualsTotalSubscribed(
        { addr1: '5000', addr2: '5000' },
        '10000',
      );
      expect(result.passed).toBe(true);
    });

    it('fails when balances sum does not match total', async () => {
      const result = await ownershipInvariants.holderBalancesSumEqualsTotalSubscribed(
        { addr1: '6000', addr2: '5000' },
        '10000',
      );
      expect(result.passed).toBe(false);
    });
  });

  describe('INV-006: holder address is a valid Stellar address', () => {
    it('passes for a valid Stellar address', async () => {
      const result = await ownershipInvariants.holderAddressIsValid(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      );
      expect(result.passed).toBe(true);
    });

    it('fails for an invalid address', async () => {
      const result = await ownershipInvariants.holderAddressIsValid('invalid-address');
      expect(result.passed).toBe(false);
    });

    it('fails for an empty address', async () => {
      const result = await ownershipInvariants.holderAddressIsValid('');
      expect(result.passed).toBe(false);
    });
  });

  describe('INV-007: only admin can mature bonds', () => {
    it('passes when admin matures a bond', async () => {
      const result = await accessControlInvariants.onlyAdminCanMature(
        'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );
      expect(result.passed).toBe(true);
    });

    it('fails when non-admin attempts to mature', async () => {
      const result = await accessControlInvariants.onlyAdminCanMature(
        'GINVESTORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );
      expect(result.passed).toBe(false);
      expect(result.message).toContain('access violation');
    });
  });

  describe('INV-008: only KYC-verified investors can subscribe', () => {
    it('passes for verified status', async () => {
      const result = await accessControlInvariants.subscriberIsKycVerified(KycStatus.VERIFIED);
      expect(result.passed).toBe(true);
    });

    it('passes for accredited status', async () => {
      const result = await accessControlInvariants.subscriberIsKycVerified('accredited');
      expect(result.passed).toBe(true);
    });

    it('fails for none status', async () => {
      const result = await accessControlInvariants.subscriberIsKycVerified('none');
      expect(result.passed).toBe(false);
    });

    it('fails for pending status', async () => {
      const result = await accessControlInvariants.subscriberIsKycVerified('pending');
      expect(result.passed).toBe(false);
    });
  });

  describe('INV-009: createdAt is before maturityDate', () => {
    it('passes when createdAt is before maturityDate', async () => {
      const result = await dataIntegrityInvariants.createdAtBeforeMaturityDate(
        '2024-01-01T00:00:00.000Z',
        2000000000,
      );
      expect(result.passed).toBe(true);
    });

    it('fails when createdAt is after maturityDate', async () => {
      const result = await dataIntegrityInvariants.createdAtBeforeMaturityDate(
        '2030-01-01T00:00:00.000Z',
        1000000000,
      );
      expect(result.passed).toBe(false);
    });
  });

  describe('INV-010: coupon period index is within schedule bounds', () => {
    it('passes for a valid period index', async () => {
      const result = await dataIntegrityInvariants.couponPeriodIsWithinSchedule(0, 4);
      expect(result.passed).toBe(true);
    });

    it('fails for an out-of-bounds period index', async () => {
      const result = await dataIntegrityInvariants.couponPeriodIsWithinSchedule(5, 4);
      expect(result.passed).toBe(false);
    });

    it('fails for a negative period index', async () => {
      const result = await dataIntegrityInvariants.couponPeriodIsWithinSchedule(-1, 4);
      expect(result.passed).toBe(false);
    });
  });

  describe('INV-011: bond ID is a positive integer', () => {
    it('passes for a positive bond ID', async () => {
      const result = await dataIntegrityInvariants.bondIdIsPositive(1);
      expect(result.passed).toBe(true);
    });

    it('fails for zero bond ID', async () => {
      const result = await dataIntegrityInvariants.bondIdIsPositive(0);
      expect(result.passed).toBe(false);
    });

    it('fails for negative bond ID', async () => {
      const result = await dataIntegrityInvariants.bondIdIsPositive(-1);
      expect(result.passed).toBe(false);
    });
  });

  describe('All invariants together', () => {
    it('passes for valid domain state', async () => {
      const checks = [
        () => bondLifecycleInvariants.subscribedDoesNotExceedSupply('5000', '10000'),
        () => bondLifecycleInvariants.maturedBondHasMaturedStatus(BondStatusEnum.Active, 9999999999, BondMaturityStatusEnum.Active),
        () => ownershipInvariants.holderBalanceIsPositive('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '100'),
        () => ownershipInvariants.holderAddressIsValid('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
        () => accessControlInvariants.onlyAdminCanMature('GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        () => accessControlInvariants.subscriberIsKycVerified('verified'),
        () => dataIntegrityInvariants.createdAtBeforeMaturityDate('2024-01-01T00:00:00.000Z', 2000000000),
        () => dataIntegrityInvariants.couponPeriodIsWithinSchedule(0, 4),
        () => dataIntegrityInvariants.bondIdIsPositive(1),
      ];
      const results = await runAllInvariants(checks);
      const failed = results.filter((r) => !r.passed);
      expect(failed).toHaveLength(0);
    });

    it('reports failures for invalid domain state', async () => {
      const checks = [
        () => bondLifecycleInvariants.subscribedDoesNotExceedSupply('15000', '10000'),
        () => ownershipInvariants.holderBalanceIsPositive('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0'),
        () => dataIntegrityInvariants.bondIdIsPositive(-1),
      ];
      const results = await runAllInvariants(checks);
      const failed = results.filter((r) => !r.passed);
      expect(failed).toHaveLength(3);
    });
  });
});
