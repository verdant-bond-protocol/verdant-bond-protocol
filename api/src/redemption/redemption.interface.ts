export interface EarlyRedemptionRequest {
  bondId: number;
  investorAddress: string;
  amount: string;
  performanceData?: PerformanceMetrics;
}

export interface PerformanceMetrics {
  trailingAverageScore: number;
  reportPeriods: number;
  targetVsActual: number;
  timeToMaturity: number;
}

export interface RedemptionPayout {
  requestedAmount: string;
  payoutAmount: string;
  penaltyAmount: string;
  penaltyBreakdown: PenaltyBreakdown;
  isAllowed: boolean;
  reason?: string;
}

export interface PenaltyBreakdown {
  performancePenaltyPercentage: number;
  timingPenaltyPercentage: number;
  totalPenaltyPercentage: number;
  notes: string;
}

export interface SolvencyCheck {
  totalRedemptionsRequested: string;
  totalRedemptionsCap: string;
  currentPeriodRedemptions: string;
  remainingCapacity: string;
  isSolvent: boolean;
}

export interface TrancheProtection {
  trancheName: string;
  couponObligations: string;
  projectedCouponPayable: string;
  availableLiquidity: string;
  isProtected: boolean;
}
