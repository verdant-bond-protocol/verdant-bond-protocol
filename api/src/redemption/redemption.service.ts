import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  EarlyRedemptionRequest,
  RedemptionPayout,
  SolvencyCheck,
  TrancheProtection,
  PerformanceMetrics,
} from './redemption.interface';
import { BondsService } from '../bonds/bonds.service';
import { OracleService } from '../oracle/oracle.service';

@Injectable()
export class RedemptionService {
  private readonly logger = new Logger(RedemptionService.name);
  private readonly SOLVENCY_RESERVE_PERCENTAGE = 20;

  constructor(
    private readonly bondsService: BondsService,
    private readonly oracleService?: OracleService,
  ) {}

  async evaluateEarlyRedemption(request: EarlyRedemptionRequest): Promise<RedemptionPayout> {
    const amount = BigInt(request.amount);

    if (amount <= BigInt('0')) {
      throw new BadRequestException('Redemption amount must be greater than zero');
    }

    try {
      const bond = await this.bondsService.findOne(request.bondId);
      const now = Math.floor(Date.now() / 1000);

      if (now >= bond.maturityDate) {
        throw new BadRequestException('Bond has already matured, standard redemption applies');
      }

      const timeToMaturity = Math.floor((bond.maturityDate - now) / 86400);
      const isEarlyRedemption = timeToMaturity > 0;

      if (!isEarlyRedemption) {
        return {
          requestedAmount: request.amount,
          payoutAmount: request.amount,
          penaltyAmount: '0',
          penaltyBreakdown: {
            performancePenaltyPercentage: 0,
            timingPenaltyPercentage: 0,
            totalPenaltyPercentage: 0,
            notes: 'Bond at or past maturity, no penalty applied',
          },
          isAllowed: true,
        };
      }

      const performanceMetrics = request.performanceData || (await this.fetchPerformanceMetrics(request.bondId));
      const payout = this.calculateRedemptionPayout(amount, performanceMetrics, timeToMaturity);

      return payout;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Error evaluating early redemption for bond ${request.bondId}`, error);
      throw new BadRequestException('Unable to evaluate early redemption at this time');
    }
  }

  async checkSolvencyForRedemption(
    bondId: number,
    totalRedemptionAmount: string,
  ): Promise<SolvencyCheck> {
    try {
      const bond = await this.bondsService.findOne(bondId);
      const holders = await this.bondsService.getHolders(bondId);
      const couponData = await this.bondsService.getUndistributedTotal(bondId);

      const amount = BigInt(totalRedemptionAmount);
      const undistributed = BigInt(couponData.undistributedTotal);

      const totalHolders = holders.holders.length;
      const estimatedCouponObligation = undistributed + (BigInt(bond.couponRate || '0') * BigInt(totalHolders)) / BigInt(100);

      const reserveRequired = estimatedCouponObligation * BigInt(this.SOLVENCY_RESERVE_PERCENTAGE) / BigInt(100);
      const totalCapacity = undistributed - reserveRequired;

      const isSolvent = amount <= totalCapacity;

      return {
        totalRedemptionsRequested: totalRedemptionAmount,
        totalRedemptionsCap: totalCapacity.toString(),
        currentPeriodRedemptions: amount.toString(),
        remainingCapacity: (totalCapacity - amount).toString(),
        isSolvent,
      };
    } catch (error) {
      this.logger.error(`Error checking solvency for bond ${bondId}`, error);
      throw new BadRequestException('Unable to verify bond solvency');
    }
  }

  async verifyTrancheProtection(bondId: number, redemptionAmount: string): Promise<TrancheProtection> {
    try {
      const bond = await this.bondsService.findOne(bondId);
      const couponData = await this.bondsService.getUndistributedTotal(bondId);

      const amount = BigInt(redemptionAmount);
      const undistributed = BigInt(couponData.undistributedTotal);

      const couponObligations = undistributed;
      const projectedPayable = amount;
      const available = undistributed - amount;
      const isProtected = available >= couponObligations * BigInt(50) / BigInt(100);

      return {
        trancheName: bond.trancheName || 'standard',
        couponObligations: couponObligations.toString(),
        projectedCouponPayable: projectedPayable.toString(),
        availableLiquidity: available.toString(),
        isProtected,
      };
    } catch (error) {
      this.logger.error(`Error verifying tranche protection for bond ${bondId}`, error);
      throw new BadRequestException('Unable to verify tranche protection');
    }
  }

  private calculateRedemptionPayout(
    amount: bigint,
    performanceMetrics: PerformanceMetrics,
    timeToMaturityDays: number,
  ): RedemptionPayout {
    const performanceScore = performanceMetrics.trailingAverageScore;
    const yearFraction = timeToMaturityDays / 365;

    const performancePenaltyPercentage = Math.max(0, Math.abs(performanceScore) * 0.5);
    const timingPenaltyPercentage = Math.max(0, (1 - yearFraction) * 10);
    const totalPenaltyPercentage = performancePenaltyPercentage + timingPenaltyPercentage;

    const penaltyBps = Math.round(totalPenaltyPercentage * 100);
    const penaltyAmount = (amount * BigInt(penaltyBps)) / BigInt(10000);
    const payoutAmount = amount - penaltyAmount;

    const isAllowed = payoutAmount >= BigInt('0');

    return {
      requestedAmount: amount.toString(),
      payoutAmount: payoutAmount.toString(),
      penaltyAmount: penaltyAmount.toString(),
      penaltyBreakdown: {
        performancePenaltyPercentage,
        timingPenaltyPercentage,
        totalPenaltyPercentage,
        notes:
          performanceScore < 0
            ? `Project underperformance detected (score: ${performanceScore}). Penalty applied proportionally.`
            : `Early redemption penalty based on ${timeToMaturityDays} days remaining to maturity.`,
      },
      isAllowed,
    };
  }

  private async fetchPerformanceMetrics(bondId: number): Promise<PerformanceMetrics> {
    if (!this.oracleService) {
      return {
        trailingAverageScore: 0,
        reportPeriods: 1,
        targetVsActual: 0,
        timeToMaturity: 0,
      };
    }

    try {
      const bond = await this.bondsService.findOne(bondId);
      const now = Math.floor(Date.now() / 1000);
      const timeToMaturity = Math.max(0, bond.maturityDate - now);

      return {
        trailingAverageScore: 0,
        reportPeriods: 4,
        targetVsActual: 0,
        timeToMaturity: Math.floor(timeToMaturity / 86400),
      };
    } catch (error) {
      this.logger.warn(`Failed to fetch performance metrics for bond ${bondId}`, error);
      return {
        trailingAverageScore: 0,
        reportPeriods: 1,
        targetVsActual: 0,
        timeToMaturity: 0,
      };
    }
  }
}
