import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/services/redis.service';
import { HolderIndexService } from './holder-index.service';

/**
 * Severity levels for stale-detection findings.
 *
 * - WARNING  – the index is within staleness bounds but approaching them.
 * - STALE    – the index has exceeded the configured maximum staleness.
 * - UNSEEDED – the index has never been seeded; coupon distribution is blocked.
 */
export type StaleSeverity = 'WARNING' | 'STALE' | 'UNSEEDED';

/** One operator-visible finding returned by the detection scan. */
export interface StaleFinding {
  bondId: number;
  severity: StaleSeverity;
  /** Unix-ms timestamp of last successful reconciliation, or 0 if never. */
  lastReconciledAt: number;
  /** Human-readable ISO timestamp, or 'never'. */
  lastReconciledAtIso: string;
  /** Age in milliseconds since last reconciliation. */
  ageMs: number;
  /** Structured action the operator should take to repair. */
  repairAction: RepairAction;
}

/** Structured repair recommendation attached to each finding. */
export interface RepairAction {
  /**
   * Machine-readable command the operator (or an automated job) should run.
   * Example: `reindex --bond-id 3` or `reconcile --bond-id 3 --all-known`.
   */
  command: string;
  /** Human-readable description of what the command does. */
  description: string;
  /**
   * Whether this repair can be queued automatically by the system (true) or
   * requires manual operator intervention (false).
   */
  automatable: boolean;
}

/** Summary result returned by a full stale-detection scan. */
export interface StaleDetectionReport {
  scannedAt: string;
  scannedBonds: number;
  /** Number of bonds whose Redis holder-set cache is absent (evicted / never warmed). */
  staleCacheCount: number;
  /** Number of bonds whose durable index has exceeded the staleness threshold. */
  staleIndexCount: number;
  /** Number of bonds that have never been reconciled. */
  unseededCount: number;
  findings: StaleFinding[];
  /** Overall health: OK | DEGRADED | CRITICAL */
  health: 'OK' | 'DEGRADED' | 'CRITICAL';
}

/**
 * Default staleness thresholds (overrideable via env).
 *
 * WARNING_MS   – age at which a finding is promoted to WARNING.
 * STALE_MS     – age at which a finding is promoted to STALE and
 *                coupon distribution would be blocked.
 */
const DEFAULT_WARNING_MS = Number(process.env.HOLDER_INDEX_WARNING_MS ?? 1_800_000); // 30 min
const DEFAULT_STALE_MS = Number(process.env.HOLDER_INDEX_MAX_STALENESS_MS ?? 3_600_000); // 60 min

/**
 * Detects stale Redis holder-set caches and stale durable holder-index
 * entries, then attaches structured repair recommendations that an operator
 * or automated job can act on.
 *
 * This service is read-only: it never modifies the index.  Actual repairs
 * are performed by `HolderIndexService.reconcileBond` (automatable) or a
 * manual operator workflow (non-automatable).
 *
 * Issue #385 — stale-cache and stale-index detection with automated repair
 * recommendations.
 */
@Injectable()
export class StaleIndexDetectionService {
  private readonly logger = new Logger(StaleIndexDetectionService.name);

  constructor(
    private readonly holderIndexService: HolderIndexService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Scan every bond in `bondIds` for staleness.
   *
   * A bond is considered stale when:
   *   (a) its Redis holder-set key is absent (cache miss / eviction), or
   *   (b) `lastReconciled` in the durable store is 0 (never seeded) or
   *       has exceeded `staleMs`.
   *
   * Each finding carries a `repairAction` telling operators (or automated
   * workers) what to do next.
   */
  async scan(
    bondIds: number[],
    nowMs = Date.now(),
    warnMs = DEFAULT_WARNING_MS,
    staleMs = DEFAULT_STALE_MS,
  ): Promise<StaleDetectionReport> {
    const scannedAt = new Date(nowMs).toISOString();
    const findings: StaleFinding[] = [];
    let staleCacheCount = 0;

    for (const bondId of bondIds) {
      // ── 1. Durable-index staleness check ──────────────────────────────────
      const store = this.holderIndexService.getStore();
      const lastReconciled = store.getLastReconciled(bondId);
      const ageMs = lastReconciled === 0 ? Infinity : nowMs - lastReconciled;
      const lastReconciledAtIso =
        lastReconciled === 0 ? 'never' : new Date(lastReconciled).toISOString();

      let severity: StaleSeverity | null = null;

      if (lastReconciled === 0) {
        severity = 'UNSEEDED';
      } else if (ageMs > staleMs) {
        severity = 'STALE';
      } else if (ageMs > warnMs) {
        severity = 'WARNING';
      }

      // ── 2. Redis cache-presence check ─────────────────────────────────────
      const cacheKey = `bond:${bondId}:holders`;
      let cacheAbsent = false;
      try {
        const members = await this.redis.sMembers(cacheKey);
        if (members.length === 0) {
          cacheAbsent = true;
          staleCacheCount += 1;
          // Only upgrade to WARNING if the index itself is still fresh.
          if (severity === null) severity = 'WARNING';
        }
      } catch {
        // Redis unavailable – note as cache absent but don't crash the scan.
        cacheAbsent = true;
        staleCacheCount += 1;
        if (severity === null) severity = 'WARNING';
      }

      if (severity === null) continue; // bond is fully healthy

      findings.push({
        bondId,
        severity,
        lastReconciledAt: lastReconciled,
        lastReconciledAtIso,
        ageMs: lastReconciled === 0 ? -1 : ageMs,
        repairAction: this.buildRepairAction(bondId, severity, cacheAbsent),
      });
    }

    const staleIndexCount = findings.filter(
      (f) => f.severity === 'STALE',
    ).length;
    const unseededCount = findings.filter(
      (f) => f.severity === 'UNSEEDED',
    ).length;

    const health =
      unseededCount > 0 || staleIndexCount > 0
        ? 'CRITICAL'
        : findings.length > 0
          ? 'DEGRADED'
          : 'OK';

    const report: StaleDetectionReport = {
      scannedAt,
      scannedBonds: bondIds.length,
      staleCacheCount,
      staleIndexCount,
      unseededCount,
      findings,
      health,
    };

    if (health !== 'OK') {
      this.logger.warn(
        `StaleDetection [${health}] — bonds scanned: ${bondIds.length}, ` +
          `stale index: ${staleIndexCount}, unseeded: ${unseededCount}, ` +
          `stale cache: ${staleCacheCount}`,
      );
    }

    return report;
  }

  private buildRepairAction(
    bondId: number,
    severity: StaleSeverity,
    cacheAbsent: boolean,
  ): RepairAction {
    if (severity === 'UNSEEDED') {
      return {
        command: `reindex --bond-id ${bondId}`,
        description:
          `Bond ${bondId} holder index has never been seeded. ` +
          `Run the reindex command to scan all known addresses and seed the index before distributing coupons.`,
        automatable: false, // requires operator sign-off on first seed
      };
    }

    if (severity === 'STALE') {
      return {
        command: `reconcile --bond-id ${bondId} --all-known`,
        description:
          `Bond ${bondId} holder index is stale (last reconciled > threshold). ` +
          `Schedule a reconciliation job to refresh the index and re-warm the Redis cache.`,
        automatable: true,
      };
    }

    // WARNING – index is fresh but Redis cache is cold or absent
    if (cacheAbsent) {
      return {
        command: `warm-cache --bond-id ${bondId}`,
        description:
          `Bond ${bondId} Redis holder-set cache is absent or empty. ` +
          `Re-warm the cache from the durable index without a full reconciliation.`,
        automatable: true,
      };
    }

    return {
      command: `reconcile --bond-id ${bondId}`,
      description:
        `Bond ${bondId} holder index is approaching the staleness threshold. ` +
        `A proactive reconciliation is recommended.`,
      automatable: true,
    };
  }
}
