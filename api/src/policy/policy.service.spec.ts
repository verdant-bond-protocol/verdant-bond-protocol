import { Test, TestingModule } from '@nestjs/testing';
import { PolicyService } from './policy.service';
import { ConfigService } from '../config/config.service';
import { PolicyEvaluationContext } from './policy.interface';

describe('PolicyService', () => {
  let service: PolicyService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PolicyService,
        {
          provide: ConfigService,
          useValue: {
            getBondIssuerAddress: jest.fn(() => 'test-address'),
          },
        },
      ],
    }).compile();

    service = module.get<PolicyService>(PolicyService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('evaluateSubscriptionEligibility', () => {
    const baseContext: PolicyEvaluationContext = {
      bondId: 1,
      investorAddress: 'investor@example.com',
      amount: BigInt('100000'),
      timestamp: Math.floor(Date.now() / 1000),
    };

    it('should allow eligible subscription', () => {
      const result = service.evaluateSubscriptionEligibility(baseContext);
      expect(result.allowed).toBe(true);
      expect(result.code).toBe('APPROVED');
    });

    it('should reject subscription below minimum amount', () => {
      const result = service.evaluateSubscriptionEligibility({
        ...baseContext,
        amount: BigInt('100'),
      });
      expect(result.allowed).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          rule: 'minimum_subscription_amount',
          severity: 'error',
        }),
      );
    });

    it('should reject subscription above maximum amount', () => {
      const result = service.evaluateSubscriptionEligibility({
        ...baseContext,
        amount: BigInt('10000000000000'),
      });
      expect(result.allowed).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          rule: 'maximum_subscription_amount',
          severity: 'error',
        }),
      );
    });

    it('should reject restricted jurisdiction', () => {
      service.updatePolicyConfiguration({
        restrictedJurisdictions: ['IRAN', 'NORTH_KOREA'],
      });

      const result = service.evaluateSubscriptionEligibility({
        ...baseContext,
        jurisdiction: 'IRAN',
      });

      expect(result.allowed).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          rule: 'jurisdiction_restricted',
          severity: 'error',
        }),
      );
    });
  });

  describe('evaluateBondRedemptionEligibility', () => {
    const baseContext = {
      bondId: 1,
      investorAddress: 'investor@example.com',
      amount: BigInt('100000'),
      timestamp: Math.floor(Date.now() / 1000),
      daysRemaining: 45,
      performanceScore: 10,
    };

    it('should allow eligible redemption', () => {
      const result = service.evaluateBondRedemptionEligibility(baseContext);
      expect(result.allowed).toBe(true);
    });

    it('should flag underperformance penalty', () => {
      const result = service.evaluateBondRedemptionEligibility({
        ...baseContext,
        performanceScore: -20,
      });

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          rule: 'underperformance_penalty',
          severity: 'warning',
        }),
      );
    });

    it('should flag early redemption window', () => {
      const result = service.evaluateBondRedemptionEligibility({
        ...baseContext,
        daysRemaining: 15,
      });

      expect(result.violations).toContainEqual(
        expect.objectContaining({
          rule: 'early_redemption_window',
          severity: 'info',
        }),
      );
    });
  });

  describe('evaluateMaturityApproaching', () => {
    it('should identify bond approaching maturity', () => {
      const now = Math.floor(Date.now() / 1000);
      const maturityDate = now + 3 * 86400;
      expect(service.evaluateMaturityApproaching(maturityDate)).toBe(true);
    });

    it('should not flag bond far from maturity', () => {
      const now = Math.floor(Date.now() / 1000);
      const maturityDate = now + 30 * 86400;
      expect(service.evaluateMaturityApproaching(maturityDate)).toBe(false);
    });

    it('should not flag matured bond', () => {
      const now = Math.floor(Date.now() / 1000);
      const maturityDate = now - 1 * 86400;
      expect(service.evaluateMaturityApproaching(maturityDate)).toBe(false);
    });
  });

  describe('calculateRedemptionPenalty', () => {
    it('should calculate penalty for underperforming project', () => {
      const amount = BigInt('1000000');
      const penalty = service.calculateRedemptionPenalty(amount, -15, 90);
      expect(penalty).toBeLessThan(amount);
      expect(penalty).toBeGreaterThan(BigInt('0'));
    });

    it('should reduce penalty for performing project', () => {
      const amount = BigInt('1000000');
      const underperformingPenalty = service.calculateRedemptionPenalty(amount, -15, 90);
      const performingPenalty = service.calculateRedemptionPenalty(amount, 15, 90);
      expect(performingPenalty).toBeGreaterThan(underperformingPenalty);
    });

    it('should account for time to maturity', () => {
      const amount = BigInt('1000000');
      const earlyRedemption = service.calculateRedemptionPenalty(amount, 0, 30);
      const lateRedemption = service.calculateRedemptionPenalty(amount, 0, 180);
      expect(lateRedemption).toBeGreaterThan(earlyRedemption);
    });
  });

  describe('getPolicyConfiguration and updatePolicyConfiguration', () => {
    it('should retrieve current configuration', () => {
      const config = service.getPolicyConfiguration();
      expect(config.maxSubscriptionAmount).toBeDefined();
      expect(config.minSubscriptionAmount).toBeDefined();
    });

    it('should update configuration', () => {
      const newMax = BigInt('999999999');
      service.updatePolicyConfiguration({
        maxSubscriptionAmount: newMax,
      });

      const config = service.getPolicyConfiguration();
      expect(config.maxSubscriptionAmount).toEqual(newMax);
    });

    it('should preserve unmodified configuration values', () => {
      const originalConfig = service.getPolicyConfiguration();
      service.updatePolicyConfiguration({
        maxSubscriptionAmount: BigInt('123456789'),
      });

      const updatedConfig = service.getPolicyConfiguration();
      expect(updatedConfig.minSubscriptionAmount).toEqual(originalConfig.minSubscriptionAmount);
    });
  });
});
