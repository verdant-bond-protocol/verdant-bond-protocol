import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/services/redis.service';

/**
 * Grace-period and catch-up mechanism (#197) for oracle downtime spanning
 * a scheduled coupon payment date. Allows using last-known-good performance
 * scores with a configurable conservatism discount when oracle is unavailable,
 * with bounded extension to prevent indefinite delays.
 *
 * Emits on-chain events so frontend/backend can surface payment-delay status
 * to investors transparently.
 */

export enum GracePeriodStatus {
  NoGracePeriod = 'no_grace_period',
  Active = 'active',
  Extended = 'extended',
  Expired = 'expired',
}

export interface GracePeriodConfig {
  gracePeriodDurationSeconds: number;
  maxExtensions: number;
  conservatismDiscountPercent: number;
  lastKnownGoodPerformanceScoreAllowed: boolean;
}

export interface CouponPaymentGraceState {
  bondId: number;
  couponPeriodIndex: number;
  status: GracePeriodStatus;
  gracePeriodStartedAt: number;
  extensionCount: number;
  oracleDownSince: number;
  usedLastKnownGoodScore?: boolean;
  lastKnownGoodScore?: string;
  conservatismDiscountApplied?: number;
  delayedPaymentEventEmitted: boolean;
}

const GRACE_PERIOD_CONFIG_KEY = 'oracle:grace-period-config';
const GRACE_STATE_KEY = 'coupon:grace-state';
const DELAYED_PAYMENT_EVENTS_KEY = 'coupon:delayed-payment-events';

const DEFAULT_CONFIG: GracePeriodConfig = {
  gracePeriodDurationSeconds: 3600,
  maxExtensions: 3,
  conservatismDiscountPercent: 5,
  lastKnownGoodPerformanceScoreAllowed: true,
};

@Injectable()
export class GracePeriodService {
  private readonly logger = new Logger(GracePeriodService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Called when a scheduled coupon payment date arrives but oracle is unavailable.
   * Initiates grace period if configured, allowing use of last-known-good score
   * with conservatism discount.
   */
  async initiateGracePeriod(
    bondId: number,
    couponPeriodIndex: number,
    lastKnownGoodScore: string,
  ): Promise<CouponPaymentGraceState> {
    const config = await this.getConfig();
    if (!config.lastKnownGoodPerformanceScoreAllowed) {
      throw new Error(`Grace period not allowed for bond ${bondId}`);
    }

    const state: CouponPaymentGraceState = {
      bondId,
      couponPeriodIndex,
      status: GracePeriodStatus.Active,
      gracePeriodStartedAt: Date.now(),
      extensionCount: 0,
      oracleDownSince: Date.now(),
      usedLastKnownGoodScore: true,
      lastKnownGoodScore,
      conservatismDiscountApplied: config.conservatismDiscountPercent,
      delayedPaymentEventEmitted: false,
    };

    await this.saveState(state);
    this.logger.log(
      `[Bond ${bondId}] Initiated grace period for coupon ${couponPeriodIndex} ` +
        `(using last-known-good score ${lastKnownGoodScore} with ${config.conservatismDiscountPercent}% discount)`,
    );

    return state;
  }

  /**
   * Extends grace period if oracle remains down and extension count hasn't
   * been exceeded. Throws if max extensions reached.
   */
  async extendGracePeriod(bondId: number, couponPeriodIndex: number): Promise<CouponPaymentGraceState> {
    const state = await this.getState(bondId, couponPeriodIndex);
    if (!state) {
      throw new Error(`No grace period in progress for bond ${bondId} period ${couponPeriodIndex}`);
    }

    const config = await this.getConfig();
    if (state.extensionCount >= config.maxExtensions) {
      throw new Error(
        `Grace period extension limit (${config.maxExtensions}) exceeded for bond ${bondId}`,
      );
    }

    const extended: CouponPaymentGraceState = {
      ...state,
      status: GracePeriodStatus.Extended,
      extensionCount: state.extensionCount + 1,
      gracePeriodStartedAt: Date.now(),
    };

    await this.saveState(extended);
    this.logger.log(
      `[Bond ${bondId}] Extended grace period for coupon ${couponPeriodIndex} ` +
        `(extension ${extended.extensionCount}/${config.maxExtensions})`,
    );

    return extended;
  }

  /**
   * Checks if grace period is currently active and hasn't exceeded the
   * grace window duration.
   */
  async isGracePeriodActive(bondId: number, couponPeriodIndex: number): Promise<boolean> {
    const state = await this.getState(bondId, couponPeriodIndex);
    if (!state || state.status === GracePeriodStatus.Expired) {
      return false;
    }

    const config = await this.getConfig();
    const elapsedSeconds = (Date.now() - state.gracePeriodStartedAt) / 1000;
    return elapsedSeconds <= config.gracePeriodDurationSeconds;
  }

  /**
   * Expires grace period and emits a delayed-payment event for frontend/backend
   * consumption. Returns true if grace period was active and is now expired.
   */
  async expireGracePeriod(bondId: number, couponPeriodIndex: number): Promise<boolean> {
    const state = await this.getState(bondId, couponPeriodIndex);
    if (!state) {
      return false;
    }

    const expired: CouponPaymentGraceState = {
      ...state,
      status: GracePeriodStatus.Expired,
    };

    await this.saveState(expired);
    await this.recordDelayedPaymentEvent(bondId, couponPeriodIndex, state);

    this.logger.warn(
      `[Bond ${bondId}] Grace period expired for coupon ${couponPeriodIndex} ` +
        `(was active for ${state.extensionCount + 1} extension(s))`,
    );

    return true;
  }

  /**
   * Resolves grace period when oracle comes back online and fresh score
   * is available. Clears the grace state.
   */
  async resolveGracePeriod(bondId: number, couponPeriodIndex: number): Promise<void> {
    const stateKey = this.stateKeyOf(bondId, couponPeriodIndex);
    await this.redis.del(stateKey);
    this.logger.log(`[Bond ${bondId}] Resolved grace period for coupon ${couponPeriodIndex}`);
  }

  async getState(bondId: number, couponPeriodIndex: number): Promise<CouponPaymentGraceState | null> {
    const raw = await this.redis.get(this.stateKeyOf(bondId, couponPeriodIndex));
    return raw ? (JSON.parse(raw) as CouponPaymentGraceState) : null;
  }

  async getConfig(): Promise<GracePeriodConfig> {
    const raw = await this.redis.get(GRACE_PERIOD_CONFIG_KEY);
    if (raw) {
      return JSON.parse(raw) as GracePeriodConfig;
    }
    return DEFAULT_CONFIG;
  }

  async setConfig(config: Partial<GracePeriodConfig>): Promise<void> {
    const merged = { ...DEFAULT_CONFIG, ...config };
    await this.redis.setEx(GRACE_PERIOD_CONFIG_KEY, 86_400 * 365, JSON.stringify(merged));
    this.logger.log('Updated grace period configuration');
  }

  async listDelayedPaymentEvents(limit = 50): Promise<any[]> {
    const raw = await this.redis.get(DELAYED_PAYMENT_EVENTS_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as any[];
    return all.slice(0, limit);
  }

  private async saveState(state: CouponPaymentGraceState): Promise<void> {
    const key = this.stateKeyOf(state.bondId, state.couponPeriodIndex);
    await this.redis.setEx(key, 86_400 * 7, JSON.stringify(state));
  }

  private async recordDelayedPaymentEvent(
    bondId: number,
    couponPeriodIndex: number,
    state: CouponPaymentGraceState,
  ): Promise<void> {
    const event = {
      bondId,
      couponPeriodIndex,
      eventType: 'delayed_coupon_payment',
      status: state.status,
      extensionsUsed: state.extensionCount,
      conservatismDiscount: state.conservatismDiscountApplied,
      delayedAt: new Date().toISOString(),
    };

    const existing = await this.listDelayedPaymentEvents(200);
    const updated = [event, ...existing].slice(0, 200);
    await this.redis.setEx(DELAYED_PAYMENT_EVENTS_KEY, 86_400 * 7, JSON.stringify(updated));
  }

  private stateKeyOf(bondId: number, couponPeriodIndex: number): string {
    return `${GRACE_STATE_KEY}:${bondId}:${couponPeriodIndex}`;
  }
}
