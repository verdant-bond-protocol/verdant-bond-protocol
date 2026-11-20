/**
 * API-side cross-source oracle anomaly detection (#158).
 *
 * Mirrors the standalone oracle monitor's `assessCrossSourceAnomaly` logic
 * (oracle/anomaly.ts) so the API can evaluate the same tolerance-based
 * comparisons over the on-chain reports it serves via `OracleService`. Reports
 * from independent providers for the same project-period are compared against a
 * cross-source median; a source deviation beyond the methodology family's
 * tolerance is flagged anomalous (critical when beyond twice tolerance), and
 * fewer than two sources means no comparison is possible.
 */

import { ReportStatus, ReportResponse } from './interfaces/oracle.interface';

/** Canonical methodology family keys used for tolerance selection. */
export type MethodologyFamily =
  | 'VERRA-VCS'
  | 'REMOTE-SENSING'
  | 'IOT-SENSORS'
  | 'BLUE-CARBON'
  | 'UNKNOWN';

/** Relative tolerance (as a fraction of the median) per methodology family. */
export const METHODOLOGY_TOLERANCE: Record<MethodologyFamily, number> = {
  'VERRA-VCS': 0.15,
  'REMOTE-SENSING': 0.25,
  'IOT-SENSORS': 0.35,
  'BLUE-CARBON': 0.3,
  UNKNOWN: 0.3,
};

const FAMILY_ALIASES: Array<{ family: MethodologyFamily; patterns: RegExp[] }> = [
  { family: 'VERRA-VCS', patterns: [/verra/i, /vcs/i] },
  {
    family: 'REMOTE-SENSING',
    patterns: [/remote/i, /satellite/i, /sentinel/i, /landsat/i],
  },
  { family: 'IOT-SENSORS', patterns: [/iot/i, /sensor/i] },
  {
    family: 'BLUE-CARBON',
    patterns: [/blue[\s-]?carbon/i, /mangrove/i, /seagrass/i, /saltmarsh/i, /salt[\s-]?marsh/i],
  },
];

function normalizeMethodology(methodology: string | null | undefined): MethodologyFamily {
  const raw = (methodology ?? '').trim();
  if (!raw) return 'UNKNOWN';
  for (const { family, patterns } of FAMILY_ALIASES) {
    if (patterns.some((pattern) => pattern.test(raw))) return family;
  }
  return 'UNKNOWN';
}

export type AnomalyKind =
  | 'normal'
  | 'outlier'
  | 'conflicting_sources'
  | 'missing_source';

export interface CrossSourceAssessment {
  projectId: string;
  periodKey: string;
  kind: AnomalyKind;
  severity: 'info' | 'warning' | 'critical';
  median: number | null;
  deviations: Array<{
    sourceId: string;
    value: number;
    deviation: number | null;
  }>;
  tolerance: number;
  reason: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function relativeDeviation(value: number, reference: number): number {
  if (reference === 0) return value === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(value - reference) / Math.abs(reference);
}

export interface CrossSourceReport {
  carbon: number;
  providerAddress: string;
  methodology?: string | null;
}

/**
 * Compute a cross-source anomaly assessment for a cluster of reports covering
 * the same project-period. `sourceId` is the provider address (a provider is an
 * independent source); `carbon` is the numeric carbon value parsed from the
 * report (major units — see #157). See `assessCrossSourceAnomaly` in
 * oracle/anomaly.ts for the shared algorithm.
 */
export function assessCluster(
  projectId: string,
  periodStart: number,
  periodEnd: number,
  reports: CrossSourceReport[],
): CrossSourceAssessment {
  const values = reports.map((report) => ({
    sourceId: report.providerAddress,
    methodology: report.methodology,
    carbon: report.carbon,
  }));
  const periodKey = `${periodStart}-${periodEnd}`;

  if (values.length < 2) {
    return {
      projectId,
      periodKey,
      kind: 'missing_source',
      severity: 'info',
      median: null,
      deviations: values.map(({ sourceId, carbon }) => ({
        sourceId,
        value: carbon,
        deviation: null,
      })),
      tolerance: METHODOLOGY_TOLERANCE.UNKNOWN,
      reason: `Only ${values.length} independent source(s) report this period; at least two are required for a cross-source comparison.`,
    };
  }

  const family = normalizeMethodology(values[0]?.methodology);
  const tolerance = METHODOLOGY_TOLERANCE[family] ?? METHODOLOGY_TOLERANCE.UNKNOWN;
  const med = median(values.map((value) => value.carbon));
  const deviations = values.map(({ sourceId, carbon }) => ({
    sourceId,
    value: carbon,
    deviation: relativeDeviation(carbon, med),
  }));

  const outliers = deviations.filter(
    (entry) => entry.deviation !== null && entry.deviation > tolerance,
  );

  if (outliers.length === 0) {
    return {
      projectId,
      periodKey,
      kind: 'normal',
      severity: 'info',
      median: med,
      deviations,
      tolerance,
      reason: `All ${values.length} sources agree within ${Math.round(tolerance * 100)}% of the median.`,
    };
  }

  const maxDeviation = Math.max(...outliers.map((entry) => entry.deviation as number));
  const severity: 'warning' | 'critical' = maxDeviation > tolerance * 2 ? 'critical' : 'warning';
  const worst = outliers.reduce((a, b) =>
    (b.deviation as number) > (a.deviation as number) ? b : a,
  );

  if (outliers.length >= 2) {
    return {
      projectId,
      periodKey,
      kind: 'conflicting_sources',
      severity,
      median: med,
      deviations,
      tolerance,
      reason: `${outliers.length} sources disagree with the median by more than ${Math.round(tolerance * 100)}% ` +
        `(worst: ${worst.sourceId} deviates ${Math.round((worst.deviation as number) * 100)}%).`,
    };
  }

  return {
    projectId,
    periodKey,
    kind: 'outlier',
    severity,
    median: med,
    deviations,
    tolerance,
    reason: `Source ${worst.sourceId} deviates ${Math.round((worst.deviation as number) * 100)}% ` +
      `from the median, beyond the ${Math.round(tolerance * 100)}% tolerance for ${family}.`,
  };
}

/**
 * Compute anomaly assessments across every project-period cluster in a set of
 * reports. Reports are clustered by project + period, using only verified
 * reports (unverified/disputed reports are not trustworthy cross-checks).
 */
export function computeCrossSourceAnomalies(
  reports: ReportResponse[],
): CrossSourceAssessment[] {
  const verified = reports.filter((report) => report.status === ReportStatus.Verified);
  const clusters = new Map<string, CrossSourceReport[]>();
  const keys = new Map<string, { projectId: string; periodStart: number; periodEnd: number }>();

  for (const report of verified) {
    const carbon = Number(report.carbonSequestered);
    if (!Number.isFinite(carbon)) continue;
    const key = `${report.projectId}::${report.periodStart}-${report.periodEnd}`;
    if (!clusters.has(key)) {
      clusters.set(key, []);
      keys.set(key, {
        projectId: report.projectId,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
      });
    }
    clusters.get(key)!.push({
      providerAddress: report.providerAddress,
      methodology: report.methodology,
      carbon,
    });
  }

  return [...clusters.entries()].map(([key, clusterReports]) => {
    const { projectId, periodStart, periodEnd } = keys.get(key)!;
    return assessCluster(projectId, periodStart, periodEnd, clusterReports);
  });
}
