import { SetMetadata } from '@nestjs/common';

export const RISK_SCORED_KEY = 'risk_scored';

export interface RiskScoredOptions {
  /** Logical operation id, e.g. `bond.issue`. Used for criticality and telemetry. */
  operation: string;
  /**
   * Request body fields (checked in order) that carry the notional amount.
   * The first finite numeric value is used as `amountUsd`.
   */
  amountFields?: string[];
}

/**
 * Opt-in marker that enables risk scoring for a high-impact endpoint (#375).
 * Endpoints without this metadata are never scored, so the guard is safe to
 * register globally.
 */
export const RiskScored = (options: RiskScoredOptions): MethodDecorator =>
  SetMetadata(RISK_SCORED_KEY, options);
