import { Injectable } from '@nestjs/common';
import { scoreRisk } from './risk-scorer';
import {
  DEFAULT_RISK_CONFIG,
  RiskAssessment,
  RiskConfig,
  RiskSignals,
} from './risk.types';

export interface RiskAssessmentInput {
  operation: string;
  actor: string;
  amountUsd?: number;
  kycVerified?: boolean;
  ip?: string;
  now?: number;
}

/**
 * Collects lightweight behavioural signals and scores a high-impact operation
 * (#375). Counters are kept in-process with a rolling time window; this is an
 * intentionally dependency-free vertical slice that degrades gracefully when
 * Redis is unavailable.
 *
 * Set `RISK_DETECTION_ENABLED=false` to disable scoring entirely (rollback
 * lever — see docs/risk-scored-abuse-detection.md).
 */
@Injectable()
export class RiskService {
  private config: RiskConfig = RiskService.configFromEnv();
  private readonly events = new Map<string, number[]>();
  private readonly rejections = new Map<string, number[]>();
  private readonly lastOrigin = new Map<string, string>();

  constructor() {}

  /** Override configuration (used by tests and by ops tooling). */
  configure(overrides: Partial<RiskConfig>): void {
    this.config = { ...this.config, ...overrides };
  }

  getConfig(): RiskConfig {
    return { ...this.config };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Record a rejected operation so subsequent attempts score higher. */
  recordRejection(actor: string, now: number = Date.now()): void {
    const cutoff = now - this.config.windowSeconds * 1000;
    const existing = (this.rejections.get(actor) ?? []).filter((ts) => ts >= cutoff);
    existing.push(now);
    this.rejections.set(actor, existing);
  }

  assess(input: RiskAssessmentInput): RiskAssessment {
    const now = input.now ?? Date.now();
    const windowMs = this.config.windowSeconds * 1000;
    const cutoff = now - windowMs;

    const priorEvents = (this.events.get(input.actor) ?? []).filter((ts) => ts >= cutoff);
    const isNewActor = priorEvents.length === 0;
    priorEvents.push(now);
    this.events.set(input.actor, priorEvents);
    const velocityCount = priorEvents.length;

    const recentRejections = (this.rejections.get(input.actor) ?? []).filter((ts) => ts >= cutoff).length;

    const previousOrigin = this.lastOrigin.get(input.actor);
    const ipChanged = Boolean(input.ip && previousOrigin && previousOrigin !== input.ip);
    if (input.ip) this.lastOrigin.set(input.actor, input.ip);

    const signals: RiskSignals = {
      operation: input.operation,
      actor: input.actor,
      amountUsd: Number.isFinite(input.amountUsd) ? Number(input.amountUsd) : 0,
      velocityCount,
      isNewActor,
      kycVerified: input.kycVerified === true,
      recentRejections,
      ipChanged,
    };

    return scoreRisk(signals, this.config);
  }

  /** Visible for the diagnostics/verification tooling. */
  static configFromEnv(env: NodeJS.ProcessEnv = process.env): RiskConfig {
    return {
      enabled: env.RISK_DETECTION_ENABLED !== 'false',
      windowSeconds: RiskService.intFromEnv(env.RISK_WINDOW_SECONDS, DEFAULT_RISK_CONFIG.windowSeconds),
      stepUpThreshold: RiskService.intFromEnv(env.RISK_STEP_UP_THRESHOLD, DEFAULT_RISK_CONFIG.stepUpThreshold),
      reviewThreshold: RiskService.intFromEnv(env.RISK_REVIEW_THRESHOLD, DEFAULT_RISK_CONFIG.reviewThreshold),
      amountStepUpUsd: RiskService.intFromEnv(env.RISK_AMOUNT_STEP_UP_USD, DEFAULT_RISK_CONFIG.amountStepUpUsd),
      amountReviewUsd: RiskService.intFromEnv(env.RISK_AMOUNT_REVIEW_USD, DEFAULT_RISK_CONFIG.amountReviewUsd),
      velocityStepUp: RiskService.intFromEnv(env.RISK_VELOCITY_STEP_UP, DEFAULT_RISK_CONFIG.velocityStepUp),
      velocityReview: RiskService.intFromEnv(env.RISK_VELOCITY_REVIEW, DEFAULT_RISK_CONFIG.velocityReview),
    };
  }

  private static intFromEnv(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
