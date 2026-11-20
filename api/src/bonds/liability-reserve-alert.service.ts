import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../common/services/redis.service';
import { NotificationsService } from '../notifications/notifications.service';

export type AlertSeverity =
  | 'ADEQUATE'
  | 'WARNING'
  | 'CRITICAL_DEFICIT'
  | 'EMERGENCY_INSOLVENCY';

export type AlertStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface AlertAuditEntry {
  timestamp: string;
  action: 'TRIGGERED' | 'RETRIED' | 'ESCALATED' | 'ACKNOWLEDGED' | 'RESOLVED';
  actor?: string;
  details: string;
}

export interface LiabilityReserveAlertRecord {
  alertId: string;
  bondId: number;
  totalLiabilities: string; // serialized BigInt string
  availableReserves: string; // serialized BigInt string
  shortfall: string; // serialized BigInt string
  coverageBps: number; // 0..10000 basis points
  severity: AlertSeverity;
  status: AlertStatus;
  triggeredAt: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  retryCount: number;
  reason: string;
  auditTrail: AlertAuditEntry[];
}

export interface BondLiabilityBreakdown {
  principalLiability: bigint;
  couponLiability: bigint;
  penaltyLiability?: bigint;
  totalLiability?: bigint;
}

export interface ReserveFundingBreakdown {
  escrowBalance: bigint;
  bufferBalance: bigint;
  insuranceBalance?: bigint;
  totalReserves?: bigint;
}

export interface ThresholdConfig {
  warningThresholdBps?: number; // e.g. 9000 (90%)
  criticalThresholdBps?: number; // e.g. 8000 (80%)
  emergencyThresholdBps?: number; // e.g. 5000 (50%)
}

export interface AcknowledgeAlertDto {
  actor: string;
  role: string;
  note?: string;
}

export interface ResolveAlertDto {
  actor: string;
  role: string;
  replenishedAmount: bigint | string;
  note?: string;
}

const DEFAULT_WARNING_BPS = 9000;
const DEFAULT_CRITICAL_BPS = 8000;
const DEFAULT_EMERGENCY_BPS = 5000;

const AUTHORIZED_ACK_ROLES = ['admin', 'risk_officer', 'settlement_admin', 'operator'];
const AUTHORIZED_RESOLVE_ROLES = ['admin', 'settlement_admin'];

@Injectable()
export class LiabilityReserveAlertService {
  private readonly logger = new Logger(LiabilityReserveAlertService.name);

  // In-memory alert storage (backed by Redis when available)
  private readonly alerts = new Map<string, LiabilityReserveAlertRecord>();
  private readonly bondActiveAlerts = new Map<number, string>();

  private readonly warningThresholdBps: number;
  private readonly criticalThresholdBps: number;
  private readonly emergencyThresholdBps: number;

  constructor(
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly redis?: RedisService,
    @Optional() config?: ThresholdConfig,
  ) {
    const warning = config?.warningThresholdBps ?? DEFAULT_WARNING_BPS;
    const critical = config?.criticalThresholdBps ?? DEFAULT_CRITICAL_BPS;
    const emergency = config?.emergencyThresholdBps ?? DEFAULT_EMERGENCY_BPS;

    if (warning < critical || critical < emergency || warning > 10000 || emergency < 0) {
      throw new BadRequestException('Invalid threshold configuration: must satisfy 10000 >= warning >= critical >= emergency >= 0');
    }

    this.warningThresholdBps = warning;
    this.criticalThresholdBps = critical;
    this.emergencyThresholdBps = emergency;
  }

  /**
   * Helper to aggregate bond liabilities.
   */
  calculateTotalLiabilities(breakdown: BondLiabilityBreakdown): bigint {
    const principal = breakdown.principalLiability;
    const coupon = breakdown.couponLiability;
    const penalty = breakdown.penaltyLiability ?? 0n;

    if (principal < 0n || coupon < 0n || penalty < 0n) {
      throw new BadRequestException('Liability components cannot be negative');
    }
    return principal + coupon + penalty;
  }

  /**
   * Helper to aggregate reserve funding balances.
   */
  calculateTotalReserves(breakdown: ReserveFundingBreakdown): bigint {
    const escrow = breakdown.escrowBalance;
    const buffer = breakdown.bufferBalance;
    const insurance = breakdown.insuranceBalance ?? 0n;

    if (escrow < 0n || buffer < 0n || insurance < 0n) {
      throw new BadRequestException('Reserve components cannot be negative');
    }
    return escrow + buffer + insurance;
  }

  /**
   * Evaluates bond liabilities against available reserve funding.
   *
   * Paths:
   * - Normal Path:
   *   - If liabilities <= reserves: auto-resolves any active alert, clears active alert state, returns resolved record (or null).
   *   - If liabilities > reserves: determines shortfall, calculates coverage BPS, classifies severity,
   *     and issues or updates alert.
   * - Failure Path:
   *   - Throws BadRequestException on negative input values or invalid arguments.
   * - Retry Path:
   *   - If an active alert exists with the SAME severity, increments `retryCount`, updates current financial figures,
   *     and suppresses duplicate alert creation.
   *   - If severity escalates, marks previous alert superseded and creates an escalated alert record.
   */
  async evaluateFunding(
    bondId: number,
    liabilitiesInput: bigint | BondLiabilityBreakdown,
    reservesInput: bigint | ReserveFundingBreakdown,
    reason = 'Periodic liability-reserve evaluation',
  ): Promise<LiabilityReserveAlertRecord | null> {
    const totalLiabilities =
      typeof liabilitiesInput === 'bigint'
        ? liabilitiesInput
        : (liabilitiesInput.totalLiability ?? this.calculateTotalLiabilities(liabilitiesInput));

    const totalReserves =
      typeof reservesInput === 'bigint'
        ? reservesInput
        : (reservesInput.totalReserves ?? this.calculateTotalReserves(reservesInput));

    if (totalLiabilities < 0n || totalReserves < 0n) {
      throw new BadRequestException('Liabilities and reserves must be non-negative');
    }

    const now = new Date().toISOString();

    // 1. Fully funded or zero liabilities: Adequate (Normal resolution path)
    if (totalLiabilities === 0n || totalReserves >= totalLiabilities) {
      const activeAlertId = this.bondActiveAlerts.get(bondId);
      if (activeAlertId) {
        const alert = this.alerts.get(activeAlertId);
        if (alert && alert.status !== 'RESOLVED') {
          alert.status = 'RESOLVED';
          alert.resolvedAt = now;
          alert.availableReserves = totalReserves.toString();
          alert.shortfall = '0';
          alert.coverageBps = 10000;
          alert.severity = 'ADEQUATE';
          alert.auditTrail.push({
            timestamp: now,
            action: 'RESOLVED',
            details: `Auto-resolved: reserves (${totalReserves}) fully cover liabilities (${totalLiabilities}). Reason: ${reason}`,
          });

          this.bondActiveAlerts.delete(bondId);
          await this.persistAlert(alert);
          this.logger.log(`Bond ${bondId} liability shortfall auto-resolved.`);
          return alert;
        }
      }
      return null;
    }

    // 2. Shortfall detected: liabilities > reserves
    const shortfall = totalLiabilities - totalReserves;
    const coverageBps = Number((totalReserves * 10000n) / totalLiabilities);

    let severity: AlertSeverity = 'WARNING';
    if (coverageBps <= this.emergencyThresholdBps) {
      severity = 'EMERGENCY_INSOLVENCY';
    } else if (coverageBps <= this.criticalThresholdBps) {
      severity = 'CRITICAL_DEFICIT';
    } else {
      severity = 'WARNING';
    }

    const activeAlertId = this.bondActiveAlerts.get(bondId);
    if (activeAlertId) {
      const existing = this.alerts.get(activeAlertId);
      if (existing && existing.status !== 'RESOLVED') {
        // 3. Retry Path: Same severity -> Idempotent update without duplicate alert
        if (existing.severity === severity) {
          existing.retryCount += 1;
          existing.totalLiabilities = totalLiabilities.toString();
          existing.availableReserves = totalReserves.toString();
          existing.shortfall = shortfall.toString();
          existing.coverageBps = coverageBps;
          existing.triggeredAt = now;
          existing.auditTrail.push({
            timestamp: now,
            action: 'RETRIED',
            details: `Retry #${existing.retryCount}: shortfall=${shortfall}, reserves=${totalReserves}, coverage=${coverageBps}bps`,
          });

          await this.persistAlert(existing);
          this.dispatchNotification(existing, false);
          return existing;
        }

        // Escalation: severity worsened (or changed) -> resolve previous as superseded, create new alert
        existing.status = 'RESOLVED';
        existing.resolvedAt = now;
        existing.auditTrail.push({
          timestamp: now,
          action: 'ESCALATED',
          details: `Superseded by escalation to severity ${severity}`,
        });
        await this.persistAlert(existing);
      }
    }

    // 4. Create new alert record
    const alertId = randomUUID();
    const newAlert: LiabilityReserveAlertRecord = {
      alertId,
      bondId,
      totalLiabilities: totalLiabilities.toString(),
      availableReserves: totalReserves.toString(),
      shortfall: shortfall.toString(),
      coverageBps,
      severity,
      status: 'ACTIVE',
      triggeredAt: now,
      retryCount: 0,
      reason,
      auditTrail: [
        {
          timestamp: now,
          action: 'TRIGGERED',
          details: `Shortfall detected: liabilities=${totalLiabilities}, reserves=${totalReserves}, shortfall=${shortfall}, severity=${severity}`,
        },
      ],
    };

    this.alerts.set(alertId, newAlert);
    this.bondActiveAlerts.set(bondId, alertId);
    await this.persistAlert(newAlert);

    this.dispatchNotification(newAlert, true);
    this.logger.warn(
      `[ALERT] Bond ${bondId} liability shortfall: shortfall=${shortfall}, coverage=${coverageBps}bps, severity=${severity}`,
    );

    return newAlert;
  }

  /**
   * Authorization Path: Acknowledges an active alert.
   * Requires role in AUTHORIZED_ACK_ROLES.
   */
  async acknowledgeAlert(alertId: string, dto: AcknowledgeAlertDto): Promise<LiabilityReserveAlertRecord> {
    const alert = this.alerts.get(alertId);
    if (!alert) {
      throw new NotFoundException(`Alert ${alertId} not found`);
    }

    if (!dto.role || !AUTHORIZED_ACK_ROLES.includes(dto.role.toLowerCase())) {
      throw new ForbiddenException(`Actor role '${dto.role}' is not authorized to acknowledge alerts`);
    }

    if (alert.status === 'RESOLVED') {
      throw new BadRequestException('Cannot acknowledge a resolved alert');
    }
    if (alert.status === 'ACKNOWLEDGED') {
      throw new BadRequestException('Alert is already acknowledged');
    }

    const now = new Date().toISOString();
    alert.status = 'ACKNOWLEDGED';
    alert.acknowledgedBy = dto.actor;
    alert.acknowledgedAt = now;
    alert.auditTrail.push({
      timestamp: now,
      action: 'ACKNOWLEDGED',
      actor: `${dto.actor} (${dto.role})`,
      details: dto.note ? `Acknowledged: ${dto.note}` : 'Acknowledged by operator',
    });

    await this.persistAlert(alert);
    return alert;
  }

  /**
   * Authorization & Failure Path: Resolves an active or acknowledged alert with proof of reserve replenishment.
   * Requires role in AUTHORIZED_RESOLVE_ROLES and replenishment >= shortfall.
   */
  async resolveAlert(alertId: string, dto: ResolveAlertDto): Promise<LiabilityReserveAlertRecord> {
    const alert = this.alerts.get(alertId);
    if (!alert) {
      throw new NotFoundException(`Alert ${alertId} not found`);
    }

    if (!dto.role || !AUTHORIZED_RESOLVE_ROLES.includes(dto.role.toLowerCase())) {
      throw new ForbiddenException(`Actor role '${dto.role}' is not authorized to resolve alerts`);
    }

    if (alert.status === 'RESOLVED') {
      throw new BadRequestException('Alert is already resolved');
    }

    const replenished = typeof dto.replenishedAmount === 'bigint'
      ? dto.replenishedAmount
      : BigInt(dto.replenishedAmount);

    const requiredShortfall = BigInt(alert.shortfall);

    if (replenished < requiredShortfall) {
      throw new BadRequestException(
        `Insufficient replenishment: provided ${replenished}, required ${requiredShortfall}`,
      );
    }

    const now = new Date().toISOString();
    const currentReserves = BigInt(alert.availableReserves);
    const newReserves = currentReserves + replenished;

    alert.status = 'RESOLVED';
    alert.resolvedAt = now;
    alert.availableReserves = newReserves.toString();
    alert.shortfall = '0';
    alert.coverageBps = 10000;
    alert.severity = 'ADEQUATE';
    alert.auditTrail.push({
      timestamp: now,
      action: 'RESOLVED',
      actor: `${dto.actor} (${dto.role})`,
      details: `Manually resolved with replenishment: ${replenished}. ${dto.note || ''}`.trim(),
    });

    this.bondActiveAlerts.delete(alert.bondId);
    await this.persistAlert(alert);
    return alert;
  }

  /**
   * Retrieves an alert by its ID.
   */
  async getAlert(alertId: string): Promise<LiabilityReserveAlertRecord> {
    const alert = this.alerts.get(alertId);
    if (!alert) {
      throw new NotFoundException(`Alert ${alertId} not found`);
    }
    return alert;
  }

  /**
   * Retrieves the currently active alert for a bond, if one exists.
   */
  async getActiveAlert(bondId: number): Promise<LiabilityReserveAlertRecord | null> {
    const alertId = this.bondActiveAlerts.get(bondId);
    if (!alertId) return null;
    return this.alerts.get(alertId) ?? null;
  }

  /**
   * Lists all alerts with optional status or bondId filters.
   */
  async listAlerts(filter?: { bondId?: number; status?: AlertStatus; severity?: AlertSeverity }): Promise<LiabilityReserveAlertRecord[]> {
    let results = Array.from(this.alerts.values());
    if (filter?.bondId !== undefined) {
      results = results.filter((a) => a.bondId === filter.bondId);
    }
    if (filter?.status) {
      results = results.filter((a) => a.status === filter.status);
    }
    if (filter?.severity) {
      results = results.filter((a) => a.severity === filter.severity);
    }
    return results.sort((a, b) => new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime());
  }

  private dispatchNotification(alert: LiabilityReserveAlertRecord, isNew: boolean): void {
    if (!this.notificationsService) return;

    const eventId = isNew
      ? `liability-alert-${alert.bondId}-${alert.alertId}`
      : `liability-alert-${alert.bondId}-${alert.alertId}-retry-${alert.retryCount}`;

    try {
      this.notificationsService.createNotification({
        userId: 'admin',
        type: 'RECOVERY_INTERRUPTED', // Maps to mandatory 'settlement_failure' category
        message: `[${alert.severity}] Bond ${alert.bondId} reserve deficit: shortfall=${alert.shortfall}, coverage=${(alert.coverageBps / 100).toFixed(2)}%`,
        eventId,
      });
    } catch (err) {
      this.logger.error(`Failed to dispatch notification for alert ${alert.alertId}: ${err}`);
    }
  }

  private async persistAlert(alert: LiabilityReserveAlertRecord): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(`alert:liability:${alert.alertId}`, JSON.stringify(alert), { EX: 86400 * 30 });
        if (alert.status !== 'RESOLVED') {
          await this.redis.set(`alert:bond:${alert.bondId}:active`, alert.alertId, { EX: 86400 * 30 });
        } else {
          // Remove active alert key in Redis
          await this.redis.set(`alert:bond:${alert.bondId}:active`, '', { EX: 1 });
        }
      } catch (err) {
        this.logger.warn(`Failed to persist alert ${alert.alertId} to Redis: ${err}`);
      }
    }
  }
}
