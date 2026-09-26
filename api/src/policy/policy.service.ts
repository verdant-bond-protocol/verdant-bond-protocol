import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { PolicyConfiguration, PolicyEvaluationContext, PolicyEvaluationResult, PolicyViolation } from './policy.interface';

@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);
  private policyConfig: PolicyConfiguration = {
    maxSubscriptionAmount: BigInt('1000000000000'),
    minSubscriptionAmount: BigInt('1000'),
    maxTotalHoldings: BigInt('5000000000000'),
    restrictedJurisdictions: [],
    maturityWarningDays: 7,
    redeemptionPenaltyPercentage: 5,
    earlyRedemptionMinDaysRemaining: 30,
  };

  constructor(private readonly configService: ConfigService) {
    this.loadPolicyConfiguration();
  }

  private loadPolicyConfiguration(): void {
    try {
      const customConfig = process.env.POLICY_CONFIG ? JSON.parse(process.env.POLICY_CONFIG) : {};
      this.policyConfig = { ...this.policyConfig, ...customConfig };
      this.logger.debug('Policy configuration loaded', this.policyConfig);
    } catch (error) {
      this.logger.warn('Failed to load policy configuration, using defaults', error);
    }
  }

  evaluateSubscriptionEligibility(context: PolicyEvaluationContext): PolicyEvaluationResult {
    const violations: PolicyViolation[] = [];

    const amount = this.toBigInt(context.amount);

    if (context.jurisdiction && this.isRestrictedJurisdiction(context.jurisdiction)) {
      violations.push({
        rule: 'jurisdiction_restricted',
        severity: 'error',
        message: `Investor in jurisdiction ${context.jurisdiction} is not eligible for this bond`,
      });
    }

    if (this.policyConfig.minSubscriptionAmount && amount < this.policyConfig.minSubscriptionAmount) {
      violations.push({
        rule: 'minimum_subscription_amount',
        severity: 'error',
        message: `Subscription amount must be at least ${this.policyConfig.minSubscriptionAmount}`,
      });
    }

    if (this.policyConfig.maxSubscriptionAmount && amount > this.policyConfig.maxSubscriptionAmount) {
      violations.push({
        rule: 'maximum_subscription_amount',
        severity: 'error',
        message: `Subscription amount cannot exceed ${this.policyConfig.maxSubscriptionAmount}`,
      });
    }

    const errorViolations = violations.filter((v) => v.severity === 'error');
    return {
      allowed: errorViolations.length === 0,
      code: errorViolations.length > 0 ? 'SUBSCRIPTION_POLICY_VIOLATION' : 'APPROVED',
      message:
        errorViolations.length > 0
          ? `Subscription violates ${errorViolations.length} policy rule(s)`
          : 'Subscription is policy-compliant',
      violations,
    };
  }

  evaluateBondRedemptionEligibility(
    context: PolicyEvaluationContext & { daysRemaining: number; performanceScore: number },
  ): PolicyEvaluationResult {
    const violations: PolicyViolation[] = [];

    if (
      this.policyConfig.earlyRedemptionMinDaysRemaining &&
      context.daysRemaining < this.policyConfig.earlyRedemptionMinDaysRemaining
    ) {
      violations.push({
        rule: 'early_redemption_window',
        severity: 'info',
        message: `Bond is in final ${this.policyConfig.earlyRedemptionMinDaysRemaining} days, early redemption is limited`,
      });
    }

    if (context.performanceScore < 0) {
      violations.push({
        rule: 'underperformance_penalty',
        severity: 'warning',
        message: 'Project underperformance will reduce redemption value',
      });
    }

    return {
      allowed: true,
      code: 'REDEMPTION_ELIGIBLE',
      message: violations.length > 0 ? 'Redemption eligible with conditions' : 'Redemption eligible',
      violations,
    };
  }

  evaluateMaturityApproaching(maturityDate: number): boolean {
    if (!this.policyConfig.maturityWarningDays) return false;
    const now = Math.floor(Date.now() / 1000);
    const warningThreshold = maturityDate - this.policyConfig.maturityWarningDays * 86400;
    return now >= warningThreshold && now < maturityDate;
  }

  calculateRedemptionPenalty(amount: bigint, performanceScore: number, daysRemaining: number): bigint {
    const baseAmount = amount;
    const performanceFactor = Math.max(0, 1 - Math.abs(performanceScore) * 0.01);
    const timeFactor = Math.max(0.5, 1 - (daysRemaining / 365) * 0.5);
    const penaltyPercentage = this.policyConfig.redeemptionPenaltyPercentage || 5;

    const penaltyAmount = (baseAmount * BigInt(Math.floor(penaltyPercentage * performanceFactor * timeFactor))) / BigInt(100);
    return baseAmount - penaltyAmount;
  }

  getPolicyConfiguration(): PolicyConfiguration {
    return { ...this.policyConfig };
  }

  updatePolicyConfiguration(updates: Partial<PolicyConfiguration>): void {
    this.policyConfig = { ...this.policyConfig, ...updates };
    this.logger.info('Policy configuration updated', this.policyConfig);
  }

  private isRestrictedJurisdiction(jurisdiction: string): boolean {
    if (!this.policyConfig.restrictedJurisdictions) return false;
    return this.policyConfig.restrictedJurisdictions.some((j) => j.toUpperCase() === jurisdiction.toUpperCase());
  }

  private toBigInt(value: bigint | string | number): bigint {
    if (typeof value === 'bigint') return value;
    return BigInt(value);
  }
}
