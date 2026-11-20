/**
 * Cross-source oracle anomaly detection (#158).
 *
 * An oracle report carries a measured carbon value plus the methodology that
 * produced it. Different providers/sources can independently report the same
 * project-period (e.g. a registry estimate, a remote-sensing run, and an on-the-
 * ground IoT sensor array). This module compares those independent estimates and
 * flags when one source materially disagrees with the others, signalling a
 * possible fabrication, sensor fault, or data-entry error rather than accepting
 * a single source at face value.
 *
 * Comparison is deliberately tolerance-based: methodology families are allowed a
 * bounded relative deviation from the cross-source median before being
 * considered anomalous, and a deviation beyond twice that tolerance is treated
 * as critical. Methodologies are normalized to family keys so "VERRA-VCS 1.3",
 * "Verra Vcs", and "verra-vcs" all resolve to the same family.
 */

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

/** Default tolerance applied when a methodology maps to no known family. */
export const DEFAULT_TOLERANCE = METHODOLOGY_TOLERANCE.UNKNOWN;

const FAMILY_ALIASES: Array<{ family: MethodologyFamily; patterns: RegExp[] }> = [
  {
    family: 'VERRA-VCS',
    patterns: [/verra/i, /vcs/i],
  },
  {
    family: 'REMOTE-SENSING',
    patterns: [/remote/i, /satellite/i, /sentinel/i, /landsat/i],
  },
  {
    family: 'IOT-SENSORS',
    patterns: [/iot/i, /sensor/i],
  },
  {
    family: 'BLUE-CARBON',
    patterns: [/blue[\s-]?carbon/i, /mangrove/i, /seagrass/i, /saltmarsh/i, /salt[\s-]?marsh/i],
  },
];

/**
 * Normalize a raw methodology string to a canonical methodology family key.
 */
export function normalizeMethodology(methodology: string | null | undefined): MethodologyFamily {
  const raw = (methodology ?? '').trim();
  if (!raw) return 'UNKNOWN';
  for (const { family, patterns } of FAMILY_ALIASES) {
    if (patterns.some((pattern) => pattern.test(raw))) return family;
  }
  return 'UNKNOWN';
}

/** A single source's independent assessment of a project-period. */
export interface CrossSourceValue {
  sourceId: string;
  methodology?: string | null;
  /** Measured carbon, in the same units across all sources for a comparison. */
  carbon: number;
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
  /** Median carbon value across all sources (null when none). */
  median: number | null;
  /** Per-source deviation from the median, as a fraction (null when none). */
  deviations: Array<{ sourceId: string; value: number; deviation: number | null }>;
  tolerance: number;
  /** Human-readable explanation of the assessment. */
  reason: string;
}

export interface CrossSourceGroup {
  projectId: string;
  periodKey: string;
  values: CrossSourceValue[];
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

/**
 * Assess a single project-period for cross-source anomalies.
 *
 * - `missing_source`: fewer than two independent sources, so no cross-check is
 *   possible.
 * - `normal`: every source sits within the family tolerance of the median.
 * - `outlier`: exactly one source deviates beyond tolerance.
 * - `conflicting_sources`: two or more sources each exceed tolerance from the
 *   median (they contradict each other, not merely differ from a clear winner).
 *
 * Severity escalates to `critical` when a disqualified source deviates beyond
 * twice the family tolerance.
 */
export function assessCrossSourceAnomaly(group: CrossSourceGroup): CrossSourceAssessment {
  const { projectId, periodKey, values } = group;

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
      tolerance: DEFAULT_TOLERANCE,
      reason: `Only ${values.length} independent source(s) reported; at least two are required for a cross-source comparison.`,
    };
  }

  const family = normalizeMethodology(values[0]?.methodology);
  const tolerance = METHODOLOGY_TOLERANCE[family] ?? DEFAULT_TOLERANCE;
  const med = median(values.map((value) => value.carbon));
  const deviations = values.map(({ sourceId, carbon }) => ({
    sourceId,
    value: carbon,
    deviation: relativeDeviation(carbon, med),
  }));

  const outliers = deviations.filter((entry) => entry.deviation !== null && entry.deviation > tolerance);

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

  const maxDeviation = Math.max(
    ...outliers.map((entry) => entry.deviation as number),
  );
  const critical = maxDeviation > tolerance * 2;
  const severity: 'warning' | 'critical' = critical ? 'critical' : 'warning';
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
 * Group a flat list of reports into per project-period clusters and assess each
 * one. Reports are grouped by `projectId` + `${periodStart}-${periodEnd}`.
 */
export function assessCrossSourceAnomalies(
  groups: CrossSourceGroup[],
): CrossSourceAssessment[] {
  return groups.map(assessCrossSourceAnomaly);
}

/** Normalize a cross-source group's values into an assessment without manual grouping. */
export function groupAndAssess(
  reports: Array<{
    projectId: string;
    periodStart: number;
    periodEnd: number;
    sourceId: string;
    methodology?: string | null;
    carbon: number;
  }>,
): CrossSourceAssessment[] {
  const grouped = new Map<string, CrossSourceGroup>();
  for (const report of reports) {
    const key = `${report.projectId}::${report.periodStart}-${report.periodEnd}`;
    const spec = {
      projectId: report.projectId,
      periodKey: `${report.periodStart}-${report.periodEnd}`,
    };
    if (!grouped.has(key)) {
      grouped.set(key, { ...spec, values: [] });
    }
    grouped.get(key)!.values.push({
      sourceId: report.sourceId,
      methodology: report.methodology,
      carbon: report.carbon,
    });
  }
  return assessCrossSourceAnomalies([...grouped.values()]);
}
