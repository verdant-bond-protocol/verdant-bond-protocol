import {
  CRITICAL_OPERATIONS,
  RiskAssessment,
  RiskConfig,
  RiskSignals,
  RiskSignalContribution,
} from './risk.types';

/**
 * Pure, explainable risk score for a single high-impact operation (#375).
 *
 * Returns a 0–100 score together with the list of contributing signals. The
 * caller maps the resulting action to behaviour:
 *   - `allow`   → execute normally (the common, legitimate case).
 *   - `step_up` → require an additional verification token.
 *   - `review`  → refuse automatic execution and route to manual review.
 */
export function scoreRisk(signals: RiskSignals, config: RiskConfig): RiskAssessment {
  const reasons: RiskSignalContribution[] = [];

  if (signals.amountUsd >= config.amountReviewUsd) {
    reasons.push({ signal: 'amount_critical', weight: 35, detail: `Notional ${signals.amountUsd} USD is at/above the review threshold` });
  } else if (signals.amountUsd >= config.amountStepUpUsd) {
    reasons.push({ signal: 'amount_elevated', weight: 20, detail: `Notional ${signals.amountUsd} USD is at/above the step-up threshold` });
  } else if (signals.amountUsd >= config.amountStepUpUsd / 2) {
    reasons.push({ signal: 'amount_watch', weight: 8, detail: `Notional ${signals.amountUsd} USD is approaching the step-up threshold` });
  }

  if (signals.velocityCount >= config.velocityReview) {
    reasons.push({ signal: 'velocity_critical', weight: 30, detail: `${signals.velocityCount} operations by this actor in the last ${config.windowSeconds}s` });
  } else if (signals.velocityCount >= config.velocityStepUp) {
    reasons.push({ signal: 'velocity_elevated', weight: 15, detail: `${signals.velocityCount} operations by this actor in the last ${config.windowSeconds}s` });
  }

  if (signals.isNewActor) {
    reasons.push({ signal: 'new_actor', weight: 8, detail: 'First operation observed for this actor in the window' });
  }

  if (!signals.kycVerified) {
    reasons.push({ signal: 'kyc_unverified', weight: 20, detail: 'Actor has no verified KYC record' });
  }

  if (signals.recentRejections > 0) {
    const weight = Math.min(signals.recentRejections * 10, 30);
    reasons.push({ signal: 'recent_rejections', weight, detail: `${signals.recentRejections} recent rejection(s) for this actor` });
  }

  if (signals.ipChanged) {
    reasons.push({ signal: 'origin_changed', weight: 10, detail: 'Request origin changed since the last operation' });
  }

  if (CRITICAL_OPERATIONS.has(signals.operation)) {
    reasons.push({ signal: 'critical_operation', weight: 10, detail: `Operation ${signals.operation} has elevated blast radius` });
  }

  const rawScore = reasons.reduce((total, reason) => total + reason.weight, 0);
  const score = Math.min(100, rawScore);

  let action: RiskAssessment['action'];
  let band: RiskAssessment['band'];
  if (score >= config.reviewThreshold) {
    action = 'review';
    band = 'high';
  } else if (score >= config.stepUpThreshold) {
    action = 'step_up';
    band = 'elevated';
  } else {
    action = 'allow';
    band = 'low';
  }

  return { score, band, action, reasons };
}
