import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { RedemptionService } from './redemption.service';
import { BondsService } from '../bonds/bonds.service';
import { OracleService } from '../oracle/oracle.service';
import { EarlyRedemptionRequest } from './redemption.interface';

describe('RedemptionService', () => {
  let service: RedemptionService;
  let bondsService: BondsService;

  const mockBond = {
    id: 1,
    status: 'Active',
    maturityDate: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
    couponRate: '5',
    trancheName: 'senior',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedemptionService,
        {
          provide: BondsService,
          useValue: {
            findOne: jest.fn().mockResolvedValue(mockBond),
            getHolders: jest.fn().mockResolvedValue({ holders: Array(50).fill({}) }),
            getUndistributedTotal: jest.fn().mockResolvedValue({ undistributedTotal: '1000000' }),
          },
        },
      ],
    }).compile();

    service = module.get<RedemptionService>(RedemptionService);
    bondsService = module.get<BondsService>(BondsService);
  });

  describe('evaluateEarlyRedemption', () => {
    const baseRequest: EarlyRedemptionRequest = {
      bondId: 1,
      investorAddress: 'investor-address',
      amount: '100000',
      performanceData: {
        trailingAverageScore: 10,
        reportPeriods: 4,
        targetVsActual: 15,
        timeToMaturity: 90,
      },
    };

    it('should reject zero or negative redemption amounts', async () => {
      await expect(
        service.evaluateEarlyRedemption({
          ...baseRequest,
          amount: '0',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow early redemption with performance-based penalty', async () => {
      const result = await service.evaluateEarlyRedemption(baseRequest);

      expect(result.isAllowed).toBe(true);
      expect(BigInt(result.payoutAmount)).toBeLessThanOrEqual(BigInt(result.requestedAmount));
      expect(BigInt(result.penaltyAmount)).toBeGreaterThanOrEqual(BigInt('0'));
    });

    it('should apply higher penalty for underperforming projects', async () => {
      const underperformingResult = await service.evaluateEarlyRedemption({
        ...baseRequest,
        performanceData: {
          ...baseRequest.performanceData,
          trailingAverageScore: -20,
        },
      });

      const performingResult = await service.evaluateEarlyRedemption({
        ...baseRequest,
        performanceData: {
          ...baseRequest.performanceData,
          trailingAverageScore: 20,
        },
      });

      expect(BigInt(underperformingResult.penaltyAmount)).toBeGreaterThan(
        BigInt(performingResult.penaltyAmount),
      );
    });

    it('should apply timing penalty for early redemption', async () => {
      const earlyResult = await service.evaluateEarlyRedemption({
        ...baseRequest,
        performanceData: {
          ...baseRequest.performanceData,
          timeToMaturity: 30,
        },
      });

      const lateResult = await service.evaluateEarlyRedemption({
        ...baseRequest,
        performanceData: {
          ...baseRequest.performanceData,
          timeToMaturity: 180,
        },
      });

      expect(BigInt(earlyResult.penaltyAmount)).toBeGreaterThan(BigInt(lateResult.penaltyAmount));
    });

    it('should reject redemption for matured bonds', async () => {
      (bondsService.findOne as jest.Mock).mockResolvedValueOnce({
        ...mockBond,
        maturityDate: Math.floor(Date.now() / 1000) - 1,
      });

      await expect(service.evaluateEarlyRedemption(baseRequest)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should provide penalty breakdown details', async () => {
      const result = await service.evaluateEarlyRedemption(baseRequest);

      expect(result.penaltyBreakdown).toEqual(
        expect.objectContaining({
          performancePenaltyPercentage: expect.any(Number),
          timingPenaltyPercentage: expect.any(Number),
          totalPenaltyPercentage: expect.any(Number),
          notes: expect.any(String),
        }),
      );
    });
  });

  describe('checkSolvencyForRedemption', () => {
    it('should verify bond solvency for redemption', async () => {
      const result = await service.checkSolvencyForRedemption(1, '50000');

      expect(result).toEqual(
        expect.objectContaining({
          totalRedemptionsRequested: '50000',
          totalRedemptionsCap: expect.any(String),
          isSolvent: expect.any(Boolean),
          remainingCapacity: expect.any(String),
        }),
      );
    });

    it('should flag insolvency when redemption exceeds capacity', async () => {
      const result = await service.checkSolvencyForRedemption(1, '10000000000');

      expect(result.isSolvent).toBe(false);
    });

    it('should account for solvency reserve requirement', async () => {
      const result = await service.checkSolvencyForRedemption(1, '50000');

      expect(BigInt(result.totalRedemptionsCap)).toBeLessThan(BigInt('1000000'));
    });
  });

  describe('verifyTrancheProtection', () => {
    it('should verify that tranche obligations are protected', async () => {
      const result = await service.verifyTrancheProtection(1, '50000');

      expect(result).toEqual(
        expect.objectContaining({
          trancheName: expect.any(String),
          couponObligations: expect.any(String),
          projectedCouponPayable: expect.any(String),
          availableLiquidity: expect.any(String),
          isProtected: expect.any(Boolean),
        }),
      );
    });

    it('should flag tranche at risk when liquidity is insufficient', async () => {
      const result = await service.verifyTrancheProtection(1, '900000');

      expect(result.isProtected).toBe(false);
    });

    it('should track available liquidity post-redemption', async () => {
      const result = await service.verifyTrancheProtection(1, '100000');

      expect(BigInt(result.availableLiquidity)).toEqual(
        BigInt(result.couponObligations) - BigInt(result.projectedCouponPayable),
      );
    });
  });
});
