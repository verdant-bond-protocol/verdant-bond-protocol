import { Injectable, Logger } from '@nestjs/common';

export enum FeatureFlag {
  ENABLE_SECONDARY_MARKET = 'ENABLE_SECONDARY_MARKET',
  ENABLE_AUTO_COUPON_DISTRIBUTION = 'ENABLE_AUTO_COUPON_DISTRIBUTION',
  ENABLE_INVESTOR_REDEMPTION = 'ENABLE_INVESTOR_REDEMPTION',
  ENABLE_GOVERNANCE_PROPOSALS = 'ENABLE_GOVERNANCE_PROPOSALS',
}

export enum FeatureFlagStatus {
  DISABLED = 'disabled',
  ENABLED = 'enabled',
  DEGRADED = 'degraded',
  EMERGENCY = 'emergency',
}

export interface FeatureFlagState {
  flag: FeatureFlag;
  status: FeatureFlagStatus;
  canary?: boolean; // Canary deployment: 10% sampling
  enabledAt?: number;
  emergencyDisabledAt?: number;
  reason?: string;
}

const DEFAULT_FLAGS: Record<FeatureFlag, boolean> = {
  [FeatureFlag.ENABLE_SECONDARY_MARKET]: false,
  [FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION]: false,
  [FeatureFlag.ENABLE_INVESTOR_REDEMPTION]: false,
  [FeatureFlag.ENABLE_GOVERNANCE_PROPOSALS]: false,
};

/**
 * Feature rollout guardrails with progressive enablement and emergency disablement (#425).
 *
 * Supports:
 * - Safe feature gates (env-driven, safe defaults)
 * - Canary deployments (10% traffic sampling before full rollout)
 * - Emergency disablement (trigger on critical health metrics)
 * - Rollout audit trail (when each feature was enabled and by whom)
 */
@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private readonly flagStates = new Map<FeatureFlag, FeatureFlagState>();
  private readonly auditLog: Array<{ timestamp: string; flag: FeatureFlag; action: string; reason?: string }> = [];

  constructor() {
    this.initializeFlags();
  }

  private initializeFlags(): void {
    for (const flag of Object.values(FeatureFlag)) {
      const envValue = process.env[flag];
      const envStatus = process.env[`${flag}_STATUS`] as FeatureFlagStatus | undefined;
      const canary = process.env[`${flag}_CANARY`]?.toLowerCase() === 'true';

      const status: FeatureFlagStatus = envStatus || (envValue ? FeatureFlagStatus.ENABLED : FeatureFlagStatus.DISABLED);
      const state: FeatureFlagState = {
        flag,
        status,
        canary: canary && status === FeatureFlagStatus.ENABLED,
        enabledAt: status === FeatureFlagStatus.ENABLED ? Date.now() : undefined,
      };

      this.flagStates.set(flag, state);
      this.logger.log(`Initialized ${flag}: ${status}${canary ? ' (canary)' : ''}`);
    }
  }

  /**
   * Check if a feature is enabled.
   * If canary is enabled, use sampling (e.g., hash-based, 10% of users).
   */
  isEnabled(flag: FeatureFlag, userId?: string): boolean {
    const state = this.flagStates.get(flag);
    if (!state) return DEFAULT_FLAGS[flag];

    if (state.status === FeatureFlagStatus.DISABLED || state.status === FeatureFlagStatus.EMERGENCY) {
      return false;
    }

    if (state.canary && userId) {
      return this.isSampledUser(flag, userId, 0.1);
    }

    return state.status === FeatureFlagStatus.ENABLED;
  }

  /**
   * Enable a feature (audit recorded).
   */
  enableFeature(flag: FeatureFlag, reason: string = 'Manual rollout'): void {
    const state = this.flagStates.get(flag) || { flag, status: FeatureFlagStatus.DISABLED };
    state.status = FeatureFlagStatus.ENABLED;
    state.enabledAt = Date.now();
    state.reason = reason;
    this.flagStates.set(flag, state);

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      flag,
      action: 'enabled',
      reason,
    });

    this.logger.log(`Feature ${flag} enabled: ${reason}`);
  }

  /**
   * Enable a feature with canary deployment (10% sampling).
   */
  enableFeatureCanary(flag: FeatureFlag, reason: string = 'Canary rollout'): void {
    const state = this.flagStates.get(flag) || { flag, status: FeatureFlagStatus.DISABLED };
    state.status = FeatureFlagStatus.ENABLED;
    state.canary = true;
    state.enabledAt = Date.now();
    state.reason = reason;
    this.flagStates.set(flag, state);

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      flag,
      action: 'enabled_canary',
      reason,
    });

    this.logger.log(`Feature ${flag} enabled in canary mode (10%): ${reason}`);
  }

  /**
   * Disable a feature (e.g., due to health metric breaches).
   */
  disableFeature(flag: FeatureFlag, reason: string = 'Manual disablement'): void {
    const state = this.flagStates.get(flag) || { flag, status: FeatureFlagStatus.DISABLED };
    state.status = FeatureFlagStatus.DISABLED;
    state.reason = reason;
    this.flagStates.set(flag, state);

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      flag,
      action: 'disabled',
      reason,
    });

    this.logger.log(`Feature ${flag} disabled: ${reason}`);
  }

  /**
   * Emergency disablement: triggered by health checks or operational decisions.
   * Differs from disableFeature by marking the flag as emergency-disabled in audit.
   */
  emergencyDisable(flag: FeatureFlag, reason: string = 'Emergency incident'): void {
    const state = this.flagStates.get(flag) || { flag, status: FeatureFlagStatus.DISABLED };
    state.status = FeatureFlagStatus.EMERGENCY;
    state.emergencyDisabledAt = Date.now();
    state.reason = reason;
    this.flagStates.set(flag, state);

    this.auditLog.push({
      timestamp: new Date().toISOString(),
      flag,
      action: 'emergency_disabled',
      reason,
    });

    this.logger.error(`EMERGENCY: Feature ${flag} disabled: ${reason}`);
  }

  /**
   * Get current state of all flags.
   */
  getAllFlags(): Record<string, FeatureFlagState> {
    const result: Record<string, FeatureFlagState> = {};
    for (const flag of Object.values(FeatureFlag)) {
      result[flag] = this.flagStates.get(flag) || { flag, status: FeatureFlagStatus.DISABLED };
    }
    return result;
  }

  /**
   * Get audit log (read-only slice).
   */
  getAuditLog(): Array<{ timestamp: string; flag: FeatureFlag; action: string; reason?: string }> {
    return [...this.auditLog];
  }

  /**
   * Get audit log for a specific flag.
   */
  getFlagAuditLog(flag: FeatureFlag): Array<{ timestamp: string; flag: FeatureFlag; action: string; reason?: string }> {
    return this.auditLog.filter((entry) => entry.flag === flag);
  }

  private isSampledUser(flag: FeatureFlag, userId: string, rate: number): boolean {
    const key = `${flag}:${userId}`;
    const hash = this.simpleHash(key);
    return (hash % 100) < rate * 100;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit int
    }
    return Math.abs(hash);
  }
}
