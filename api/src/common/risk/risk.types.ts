/**
 * Risk-scored abuse detection for high-impact operations (#375).
 *
 * The scorer is deliberately pure and explainable: every point of the score
 * maps to a named signal with a human-readable detail, so a review decision
 * can be justified to an operator and to the affected user.
 */

export type RiskBand = 'low' | 'elevated' | 'high';

export type RiskAction = 'allow' | 'step_up' | 'review';

export interface RiskSignalContribution {
  /** Stable signal id, safe to expose (never contains user data). */
  signal: string;
  /** Points contributed to the final score. */
  weight: number;
  /** Explanation for humans/operators. */
  detail: string;
}

export interface RiskSignals {
  /** Logical operation being attempted, e.g. `bond.issue`. */
  operation: string;
  /** Opaque actor key (wallet address or IP) used for velocity. */
  actor: string;
  /** Notional USD value of the operation, when known. */
  amountUsd: number;
  /** Number of operations by this actor within the rolling window (incl. current). */
  velocityCount: number;
  /** True when this is the first operation seen for the actor in the window. */
  isNewActor: boolean;
  /** Whether the actor has a verified KYC record. */
  kycVerified: boolean;
  /** Rejections recorded for this actor within the window. */
  recentRejections: number;
  /** True when the caller's network origin changed since the last operation. */
  ipChanged: boolean;
}

export interface RiskAssessment {
  score: number;
  band: RiskBand;
  action: RiskAction;
  reasons: RiskSignalContribution[];
}

export interface RiskConfig {
  enabled: boolean;
  windowSeconds: number;
  stepUpThreshold: number;
  reviewThreshold: number;
  amountStepUpUsd: number;
  amountReviewUsd: number;
  velocityStepUp: number;
  velocityReview: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  enabled: true,
  windowSeconds: 60,
  stepUpThreshold: 40,
  reviewThreshold: 75,
  amountStepUpUsd: 10_000,
  amountReviewUsd: 100_000,
  velocityStepUp: 5,
  velocityReview: 10,
};

/** Operations that carry elevated blast radius and get a small fixed premium. */
export const CRITICAL_OPERATIONS: ReadonlySet<string> = new Set([
  'bond.issue',
  'settlement.redeem',
  'admin.config',
]);
