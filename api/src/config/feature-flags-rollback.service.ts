import { Injectable, Logger } from '@nestjs/common';
import { FeatureFlag, FeatureFlagStatus } from './feature-flags.service';

export interface HealthMetric {
  name: string;
  value: number;
  threshold: number;
  breached: boolean;
}

export interface RollbackVerification {
  flag: FeatureFlag;
  enabled: boolean;
  enabledAt: number;
  healthMetrics: HealthMetric[];
  lastVerified: number;
  automaticRollbackEnabled: boolean;
  rollbackReason?: string;
}

/**
 * Feature-flag rollout guard with automatic rollback verification (#372).
 *
 * Monitors health metrics during feature rollout and automatically rolls back
 * if thresholds are breached (e.g., error rate > 5%, latency > 500ms, etc).
 *
 * Verifies:
 * - Error rate thresholds
 * - Latency percentiles (p99)
 * - Resource utilization
 * - Data consistency checks
 */
@Injectable()
export class FeatureFlagsRollbackService {
  private readonly logger = new Logger(FeatureFlagsRollbackService.name);
  private readonly rollbackVerifications = new Map<FeatureFlag, RollbackVerification>();
  private readonly healthMetricsHistory = new Map<FeatureFlag, HealthMetric[][]>();

  constructor() {
    this.initializeRollbackVerifications();
  }

  private initializeRollbackVerifications(): void {
    for (const flag of Object.values(FeatureFlag)) {
      const isEnabled = process.env[flag] === 'true' || process.env[`${flag}_STATUS`] === FeatureFlagStatus.ENABLED;
      this.rollbackVerifications.set(flag, {
        flag,
        enabled: isEnabled,
        enabledAt: isEnabled ? Date.now() : 0,
        healthMetrics: this.initializeDefaultMetrics(),
        lastVerified: Date.now(),
        automaticRollbackEnabled: process.env[`${flag}_AUTO_ROLLBACK`]?.toLowerCase() === 'true' ?? true,
      });
    }
  }

  private initializeDefaultMetrics(): HealthMetric[] {
    return [
      { name: 'error_rate', value: 0, threshold: 5, breached: false },
      { name: 'p99_latency_ms', value: 0, threshold: 500, breached: false },
      { name: 'memory_usage_percent', value: 0, threshold: 85, breached: false },
      { name: 'database_connection_pool_exhaustion', value: 0, threshold: 95, breached: false },
      { name: 'inconsistent_state_count', value: 0, threshold: 0, breached: false },
    ];
  }

  /**
   * Update health metrics for a feature and verify if rollback is needed.
   */
  updateHealthMetrics(flag: FeatureFlag, metrics: Partial<HealthMetric>[]): boolean {
    const verification = this.rollbackVerifications.get(flag);
    if (!verification || !verification.enabled) {
      return false;
    }

    const updated = verification.healthMetrics.map((existing) => {
      const update = metrics.find((m) => m.name === existing.name);
      if (update) {
        return {
          ...existing,
          value: update.value ?? existing.value,
          breached: update.value != null && update.value > existing.threshold,
        };
      }
      return existing;
    });

    verification.healthMetrics = updated;
    verification.lastVerified = Date.now();

    // Store history for analysis
    if (!this.healthMetricsHistory.has(flag)) {
      this.healthMetricsHistory.set(flag, []);
    }
    this.healthMetricsHistory.get(flag)!.push([...updated]);

    const hasBreaches = updated.some((m) => m.breached);
    if (hasBreaches && verification.automaticRollbackEnabled) {
      this.triggerAutomaticRollback(flag, updated);
      return true;
    }

    return false;
  }

  private triggerAutomaticRollback(flag: FeatureFlag, breachedMetrics: HealthMetric[]): void {
    const verification = this.rollbackVerifications.get(flag)!;
    const breachDetails = breachedMetrics.filter((m) => m.breached).map((m) => `${m.name}=${m.value}`).join(', ');

    verification.enabled = false;
    verification.rollbackReason = `Automatic rollback triggered: ${breachDetails}`;

    this.logger.error(
      `AUTOMATIC ROLLBACK: Feature ${flag} disabled due to health metric breaches: ${breachDetails}`,
    );
  }

  /**
   * Manually verify if a feature should remain enabled based on health checks.
   */
  verifyHealthBeforeRollout(flag: FeatureFlag): { healthy: boolean; issues: string[] } {
    const verification = this.rollbackVerifications.get(flag);
    if (!verification) {
      return { healthy: false, issues: [`Feature ${flag} not found`] };
    }

    const issues = verification.healthMetrics.filter((m) => m.breached).map((m) => `${m.name} exceeded: ${m.value} > ${m.threshold}`);

    return {
      healthy: issues.length === 0,
      issues,
    };
  }

  /**
   * Get rollback verification status for a feature.
   */
  getRollbackStatus(flag: FeatureFlag): RollbackVerification | null {
    return this.rollbackVerifications.get(flag) ?? null;
  }

  /**
   * Get all rollback statuses.
   */
  getAllRollbackStatuses(): Record<string, RollbackVerification> {
    const result: Record<string, RollbackVerification> = {};
    for (const [flag, verification] of this.rollbackVerifications) {
      result[flag] = verification;
    }
    return result;
  }

  /**
   * Get health metrics history for analysis.
   */
  getMetricsHistory(flag: FeatureFlag, limit: number = 100): HealthMetric[][] {
    const history = this.healthMetricsHistory.get(flag) ?? [];
    return history.slice(Math.max(0, history.length - limit));
  }

  /**
   * Manually re-enable a feature after rollback (requires health verification).
   */
  reEnableAfterRollback(flag: FeatureFlag): { success: boolean; reason?: string } {
    const verification = this.verifyHealthBeforeRollout(flag);
    if (!verification.healthy) {
      return { success: false, reason: `Cannot re-enable: ${verification.issues.join('; ')}` };
    }

    const rollbackStatus = this.rollbackVerifications.get(flag);
    if (rollbackStatus) {
      rollbackStatus.enabled = true;
      rollbackStatus.enabledAt = Date.now();
      rollbackStatus.rollbackReason = undefined;
      this.logger.log(`Feature ${flag} re-enabled after rollback verification passed`);
    }

    return { success: true };
  }
}
