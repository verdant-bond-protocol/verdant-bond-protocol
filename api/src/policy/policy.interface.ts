export interface PolicyEvaluationContext {
  bondId: number;
  investorAddress: string;
  amount: bigint | string | number;
  timestamp: number;
  jurisdiction?: string;
  tranche?: string;
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  code: string;
  message: string;
  violations: PolicyViolation[];
}

export interface PolicyViolation {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface PolicyConfiguration {
  maxSubscriptionAmount?: bigint;
  minSubscriptionAmount?: bigint;
  maxTotalHoldings?: bigint;
  restrictedJurisdictions?: string[];
  allowedTransitoryStates?: string[];
  redeemptionPenaltyPercentage?: number;
  earlyRedemptionMinDaysRemaining?: number;
  maturityWarningDays?: number;
}
