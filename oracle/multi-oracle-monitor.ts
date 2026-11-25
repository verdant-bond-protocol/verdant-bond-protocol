import {
  cadenceForMethodology,
  computeStaleness,
  DEFAULT_GRACE_SECONDS,
} from './staleness';
import {
  assessCrossSource,
  CrossSourceAssessment,
  METHODOLOGY_TOLERANCE,
  normalizeMethodology,
} from './anomaly';

export interface OracleSourceReading {
  sourceId: string;
  projectId: string;
  periodKey: string;
  methodology?: string | null;
  carbon: number;
  /** ISO-8601 timestamp when the reading was observed/verified. */
  observedAt: string;
  /** Optional explicit cadence override in seconds. */
  cadenceSeconds?: number;
  /** Optional explicit grace window override in seconds. */
  graceSeconds?: number;
}

export interface MultiOracleMonitorConfig {
  /** Minimum number of fresh, authorized, non-outlier sources required. */
  minQuorum: number;
  /** Optional allowlist of authorized oracle source IDs. */
  authorizedSources?: string[];
  /** Optional evaluation timestamp in epoch ms (defaults to Date.now()). */
  nowMs?: number;
  /** Optional tolerance override (fraction of median). */
  toleranceOverride?: number;
}

export interface RejectedSourceReading {
  sourceId: string;
  reason: 'unauthorized' | 'invalid_reading' | 'stale' | 'outlier';
  detail: string;
}

export interface MultiOracleAssessment {
  projectId: string;
  periodKey: string;
  evaluatedAt: string;
  status: 'healthy' | 'degraded' | 'critical';
  quorumMet: boolean;
  minQuorum: number;
  totalSubmitted: number;
  freshCount: number;
  inlierCount: number;
  consensusCarbon: number | null;
  freshSources: string[];
  staleSources: string[];
  outlierSources: string[];
  unauthorizedSources: string[];
  rejectedReadings: RejectedSourceReading[];
  anomalyAssessment: CrossSourceAssessment | null;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Assess a batch of multi-oracle readings for a single project-period,
 * enforcing authorization, payload validity, freshness, and outlier bounds.
 */
export function assessMultiOracleFeed(
  projectId: string,
  periodKey: string,
  readings: OracleSourceReading[],
  config: MultiOracleMonitorConfig,
): MultiOracleAssessment {
  const nowMs = config.nowMs ?? Date.now();
  const evaluatedAt = new Date(nowMs).toISOString();
  const minQuorum = Math.max(1, config.minQuorum);
  const allowlist = config.authorizedSources
    ? new Set(config.authorizedSources)
    : null;

  const unauthorizedSources: string[] = [];
  const rejectedReadings: RejectedSourceReading[] = [];
  const validReadings: OracleSourceReading[] = [];

  for (const reading of readings) {
    if (allowlist && !allowlist.has(reading.sourceId)) {
      unauthorizedSources.push(reading.sourceId);
      rejectedReadings.push({
        sourceId: reading.sourceId,
        reason: 'unauthorized',
        detail: `Source ${reading.sourceId} is not in authorizedSources`,
      });
      continue;
    }

    const parsedTs = Date.parse(reading.observedAt);
    if (
      !Number.isFinite(reading.carbon) ||
      reading.carbon < 0 ||
      Number.isNaN(parsedTs)
    ) {
      rejectedReadings.push({
        sourceId: reading.sourceId,
        reason: 'invalid_reading',
        detail: 'Carbon must be non-negative finite number and observedAt must be valid ISO-8601',
      });
      continue;
    }

    validReadings.push(reading);
  }

  const stalenessResults = computeStaleness(
    validReadings.map((r) => ({
      projectId: `${r.projectId}:${r.sourceId}`,
      provider: r.sourceId,
      lastVerifiedAt: r.observedAt,
      createdAt: r.observedAt,
      cadenceSeconds:
        r.cadenceSeconds ?? cadenceForMethodology(r.methodology ?? ''),
      graceSeconds: r.graceSeconds ?? DEFAULT_GRACE_SECONDS,
    })),
    nowMs,
  );

  const freshReadings: OracleSourceReading[] = [];
  const staleSources: string[] = [];

  validReadings.forEach((reading, idx) => {
    const staleness = stalenessResults[idx];
    if (staleness.isStale) {
      staleSources.push(reading.sourceId);
      rejectedReadings.push({
        sourceId: reading.sourceId,
        reason: 'stale',
        detail: `Source ${reading.sourceId} stale (${staleness.stalenessSeconds}s > expected ${staleness.expectedNextReportAt})`,
      });
    } else {
      freshReadings.push(reading);
    }
  });

  const freshSources = freshReadings.map((r) => r.sourceId);

  if (freshReadings.length === 0) {
    return {
      projectId,
      periodKey,
      evaluatedAt,
      status: 'critical',
      quorumMet: false,
      minQuorum,
      totalSubmitted: readings.length,
      freshCount: 0,
      inlierCount: 0,
      consensusCarbon: null,
      freshSources,
      staleSources,
      outlierSources: [],
      unauthorizedSources,
      rejectedReadings,
      anomalyAssessment: null,
    };
  }

  const anomalyAssessment = assessCrossSource(
    projectId,
    periodKey,
    freshReadings.map((r) => ({
      sourceId: r.sourceId,
      methodology: r.methodology,
      carbon: r.carbon,
    })),
    config.toleranceOverride,
  );

  const family = normalizeMethodology(freshReadings[0]?.methodology);
  const tolerance =
    config.toleranceOverride ?? METHODOLOGY_TOLERANCE[family];

  const outlierSources: string[] = [];
  const inliers: OracleSourceReading[] = [];

  if (
    anomalyAssessment.kind === 'outlier' ||
    anomalyAssessment.kind === 'conflicting_sources'
  ) {
    for (const dev of anomalyAssessment.deviations) {
      const reading = freshReadings.find((r) => r.sourceId === dev.sourceId);
      if (!reading) continue;
      if (dev.deviation != null && dev.deviation > tolerance) {
        outlierSources.push(dev.sourceId);
        rejectedReadings.push({
          sourceId: dev.sourceId,
          reason: 'outlier',
          detail: `Deviation ${(dev.deviation * 100).toFixed(1)}% exceeds tolerance ${(tolerance * 100).toFixed(1)}%`,
        });
      } else {
        inliers.push(reading);
      }
    }
  } else {
    inliers.push(...freshReadings);
  }

  const quorumMet = inliers.length >= minQuorum;
  const consensusCarbon =
    quorumMet && inliers.length > 0
      ? median(inliers.map((r) => r.carbon))
      : null;

  let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
  if (!quorumMet || anomalyAssessment.kind === 'conflicting_sources') {
    status = 'critical';
  } else if (
    staleSources.length > 0 ||
    outlierSources.length > 0 ||
    unauthorizedSources.length > 0
  ) {
    status = 'degraded';
  }

  return {
    projectId,
    periodKey,
    evaluatedAt,
    status,
    quorumMet,
    minQuorum,
    totalSubmitted: readings.length,
    freshCount: freshSources.length,
    inlierCount: inliers.length,
    consensusCarbon,
    freshSources,
    staleSources,
    outlierSources,
    unauthorizedSources,
    rejectedReadings,
    anomalyAssessment,
  };
}

/**
 * Stateful multi-oracle monitor with retry support for transient feed
 * failures and per-source recovery tracking.
 */
export class MultiOracleMonitor {
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(private readonly defaultConfig: MultiOracleMonitorConfig) {}

  assess(
    projectId: string,
    periodKey: string,
    readings: OracleSourceReading[],
    overrideConfig?: Partial<MultiOracleMonitorConfig>,
  ): MultiOracleAssessment {
    const assessment = assessMultiOracleFeed(projectId, periodKey, readings, {
      ...this.defaultConfig,
      ...overrideConfig,
    });

    for (const source of assessment.freshSources) {
      if (!assessment.outlierSources.includes(source)) {
        this.consecutiveFailures.set(source, 0);
      }
    }
    for (const source of [
      ...assessment.staleSources,
      ...assessment.outlierSources,
    ]) {
      this.consecutiveFailures.set(
        source,
        (this.consecutiveFailures.get(source) ?? 0) + 1,
      );
    }

    return assessment;
  }

  getFailureCount(sourceId: string): number {
    return this.consecutiveFailures.get(sourceId) ?? 0;
  }

  /**
   * Retry fetching and assessing readings up to `maxRetries` times when
   * quorum is not yet met (e.g. transient oracle lag).
   */
  async assessWithRetry(
    projectId: string,
    periodKey: string,
    fetchReadings: (attempt: number) => Promise<OracleSourceReading[]>,
    maxRetries = 2,
    overrideConfig?: Partial<MultiOracleMonitorConfig>,
  ): Promise<{ assessment: MultiOracleAssessment; attempts: number }> {
    let lastAssessment: MultiOracleAssessment | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const readings = await fetchReadings(attempt);
      lastAssessment = this.assess(
        projectId,
        periodKey,
        readings,
        overrideConfig,
      );
      if (lastAssessment.quorumMet && lastAssessment.status !== 'critical') {
        return { assessment: lastAssessment, attempts: attempt + 1 };
      }
    }
    return {
      assessment: lastAssessment!,
      attempts: maxRetries + 1,
    };
  }
}
