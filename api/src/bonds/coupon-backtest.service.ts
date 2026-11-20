import { Injectable, Logger } from '@nestjs/common';

export interface PerformancePoint {
  periodIndex: number;
  periodStart: string;
  periodEnd: string;
  reportedCarbon: number; // In metric tons
  targetCarbon: number; // In metric tons
  totalSupply: string; // Token supply in minor units
  attestationCount: number;
  trueUpAdjustment?: number;
}

export interface PerformanceDataset {
  datasetId: string;
  projectName: string;
  creditType: string;
  baseCouponRate: string; // Minor units per token
  dataPoints: PerformancePoint[];
}

export interface PeriodBacktestResult {
  periodIndex: number;
  periodStart: string;
  periodEnd: string;
  reportedCarbon: number;
  targetCarbon: number;
  couponCreditsPerTokenV1: string;
  couponCreditsPerTokenV2: string;
  totalDistributedV1: string;
  totalDistributedV2: string;
  flaggedEdgeCases: string[];
}

export interface FormulaComparison {
  formulaV1TotalDistributed: string;
  formulaV2TotalDistributed: string;
  variancePercentage: number;
  v2CapPreventedOverpayment: string;
  v2DropFlagsCount: number;
}

export interface BacktestReport {
  datasetId: string;
  projectName: string;
  totalPeriodsEvaluated: number;
  evaluatedAt: string;
  formulaVersion: 'V1' | 'V2' | 'COMPARE';
  periodResults: PeriodBacktestResult[];
  edgeCasesSummary: {
    totalSpikesFlagged: number;
    totalDropsFlagged: number;
    zeroSupplyRiskCount: number;
    attestationDeficitCount: number;
  };
  comparison?: FormulaComparison;
}

const FIXED_POINT = 10_000_000n;
const CREDIT_MINOR_UNITS = 1_000_000n;
const MAX_PERFORMANCE_INCREASE_BPS = 10_000n; // +100%
const MAX_PERFORMANCE_DECREASE_BPS = 9_000n;  // -90%

@Injectable()
export class CouponBacktestService {
  private readonly logger = new Logger(CouponBacktestService.name);

  /**
   * Invokes Soroban coupon-engine contract logic faithfully to compute coupon yield per period.
   */
  calculateContractCoupon(
    point: PerformancePoint,
    baseCouponRateStr: string,
    formulaVersion: 'V1' | 'V2' = 'V2',
  ): { creditsPerToken: bigint; totalDistributed: bigint; edgeCases: string[] } {
    const edgeCases: string[] = [];
    const totalSupply = BigInt(point.totalSupply);
    const baseRate = BigInt(baseCouponRateStr);

    if (totalSupply === 0n) {
      edgeCases.push('ZERO_SUPPLY_DIVISION_RISK');
      return { creditsPerToken: 0n, totalDistributed: 0n, edgeCases };
    }

    if (point.targetCarbon <= 0) {
      edgeCases.push('INVALID_TARGET_CARBON');
      return { creditsPerToken: 0n, totalDistributed: 0n, edgeCases };
    }

    const ratioBps = BigInt(Math.floor((point.reportedCarbon / point.targetCarbon) * 10_000));

    if (formulaVersion === 'V1') {
      // Legacy V1 formula: unbounded linear scaling
      const creditsPerToken = (baseRate * ratioBps) / 10_000n;
      const totalDistributed = (creditsPerToken * totalSupply) / CREDIT_MINOR_UNITS;
      return { creditsPerToken, totalDistributed, edgeCases };
    }

    // Formula V2 (Current Soroban contract logic in contracts/coupon-engine/src/lib.rs)
    if (point.attestationCount < 2) {
      edgeCases.push('INSUFFICIENT_ATTESTATIONS');
    }

    if (ratioBps > 10_000n + MAX_PERFORMANCE_INCREASE_BPS) {
      edgeCases.push('PERFORMANCE_SPIKE_CLAMPED');
    } else if (ratioBps < 10_000n - MAX_PERFORMANCE_DECREASE_BPS) {
      edgeCases.push('PERFORMANCE_DROP_FLAGGED');
    }

    // Clamped performance factor for V2 calculation
    const clampedRatioBps = ratioBps > 20_000n ? 20_000n : ratioBps;

    let creditsPerToken = (baseRate * clampedRatioBps) / 10_000n;

    // Apply CarbonChain true-up adjustment if present
    if (point.trueUpAdjustment) {
      const trueUpBps = BigInt(Math.floor(point.trueUpAdjustment * 100));
      creditsPerToken = creditsPerToken + (baseRate * trueUpBps) / 10_000n;
      if (creditsPerToken < 0n) creditsPerToken = 0n;
    }

    const totalDistributed = (creditsPerToken * totalSupply) / CREDIT_MINOR_UNITS;
    return { creditsPerToken, totalDistributed, edgeCases };
  }

  /**
   * Runs historical performance backtesting over imported multi-year project performance datasets.
   */
  runBacktest(
    dataset: PerformanceDataset,
    formulaVersion: 'V1' | 'V2' | 'COMPARE' = 'COMPARE',
  ): BacktestReport {
    let v1Total = 0n;
    let v2Total = 0n;
    let spikes = 0;
    let drops = 0;
    let zeroSupplyCount = 0;
    let attestationDeficitCount = 0;
    let overpaymentSaved = 0n;

    const periodResults: PeriodBacktestResult[] = [];

    for (const point of dataset.dataPoints) {
      const v1Result = this.calculateContractCoupon(point, dataset.baseCouponRate, 'V1');
      const v2Result = this.calculateContractCoupon(point, dataset.baseCouponRate, 'V2');

      v1Total += v1Result.totalDistributed;
      v2Total += v2Result.totalDistributed;

      if (v1Result.totalDistributed > v2Result.totalDistributed) {
        overpaymentSaved += (v1Result.totalDistributed - v2Result.totalDistributed);
      }

      if (v2Result.edgeCases.includes('PERFORMANCE_SPIKE_CLAMPED')) spikes++;
      if (v2Result.edgeCases.includes('PERFORMANCE_DROP_FLAGGED')) drops++;
      if (v2Result.edgeCases.includes('ZERO_SUPPLY_DIVISION_RISK')) zeroSupplyCount++;
      if (v2Result.edgeCases.includes('INSUFFICIENT_ATTESTATIONS')) attestationDeficitCount++;

      periodResults.push({
        periodIndex: point.periodIndex,
        periodStart: point.periodStart,
        periodEnd: point.periodEnd,
        reportedCarbon: point.reportedCarbon,
        targetCarbon: point.targetCarbon,
        couponCreditsPerTokenV1: v1Result.creditsPerToken.toString(),
        couponCreditsPerTokenV2: v2Result.creditsPerToken.toString(),
        totalDistributedV1: v1Result.totalDistributed.toString(),
        totalDistributedV2: v2Result.totalDistributed.toString(),
        flaggedEdgeCases: v2Result.edgeCases,
      });
    }

    const variancePercentage =
      v1Total > 0n
        ? Number(((v2Total - v1Total) * 10000n) / v1Total) / 100
        : 0;

    this.logger.log(
      `Backtest completed for project ${dataset.projectName} across ${dataset.dataPoints.length} periods. V1 Total: ${v1Total}, V2 Total: ${v2Total}`,
    );

    return {
      datasetId: dataset.datasetId,
      projectName: dataset.projectName,
      totalPeriodsEvaluated: dataset.dataPoints.length,
      evaluatedAt: new Date().toISOString(),
      formulaVersion,
      periodResults,
      edgeCasesSummary: {
        totalSpikesFlagged: spikes,
        totalDropsFlagged: drops,
        zeroSupplyRiskCount: zeroSupplyCount,
        attestationDeficitCount: attestationDeficitCount,
      },
      comparison: {
        formulaV1TotalDistributed: v1Total.toString(),
        formulaV2TotalDistributed: v2Total.toString(),
        variancePercentage,
        v2CapPreventedOverpayment: overpaymentSaved.toString(),
        v2DropFlagsCount: drops,
      },
    };
  }

  /**
   * Generates a multi-year synthetic performance dataset for backtesting edge cases.
   */
  generateSyntheticDataset(options: {
    datasetId?: string;
    projectName?: string;
    years: number;
    baseCarbon: number;
    volatility?: number;
    includeSpike?: boolean;
    includeDrop?: boolean;
  }): PerformanceDataset {
    const periods = options.years * 4; // Quarterly performance reports
    const dataPoints: PerformancePoint[] = [];
    const baseRate = '1000000'; // 1.0 credit per token
    const totalSupply = '1000000000000'; // 1M tokens in minor units

    let currentCarbon = options.baseCarbon;

    for (let i = 1; i <= periods; i++) {
      const year = 2021 + Math.floor((i - 1) / 4);
      const quarter = ((i - 1) % 4) + 1;

      let carbon = currentCarbon + (Math.random() - 0.5) * (options.volatility || 10);

      // Inject edge cases if requested
      if (options.includeSpike && i === Math.floor(periods / 2)) {
        carbon = options.baseCarbon * 2.5; // +150% spike
      } else if (options.includeDrop && i === Math.floor(periods * 0.75)) {
        carbon = options.baseCarbon * 0.05; // -95% drop
      }

      dataPoints.push({
        periodIndex: i,
        periodStart: `${year}-Q${quarter}-START`,
        periodEnd: `${year}-Q${quarter}-END`,
        reportedCarbon: Math.round(carbon),
        targetCarbon: options.baseCarbon,
        totalSupply,
        attestationCount: 2,
      });

      currentCarbon = carbon;
    }

    return {
      datasetId: options.datasetId || `SYNTHETIC-${options.years}Y`,
      projectName: options.projectName || `Synthetic ${options.years}-Year Carbon Project`,
      creditType: 'VERRA-VCS',
      baseCouponRate: baseRate,
      dataPoints,
    };
  }
}
