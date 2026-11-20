export const DEFAULT_CADENCE_SECONDS = 365 * 24 * 60 * 60;
export const DEFAULT_GRACE_SECONDS = 30 * 24 * 60 * 60;

/** Explicit cadence overrides keyed by methodology constants from contracts/shared/src/types.rs. */
const METHODOLOGY_CADENCES: Record<string, number> = {
  'REMOTE-SENSING': 90 * 24 * 60 * 60,
  'SATELLITE': 90 * 24 * 60 * 60,
  'IOT': 30 * 24 * 60 * 60,
  'IOT-SENSORS': 30 * 24 * 60 * 60,
  'BLUE-CARBON': 90 * 24 * 60 * 60,
};

/** Expected reporting cadence for a methodology (seconds between reports). */
export function cadenceForMethodology(methodology: string): number {
  return METHODOLOGY_CADENCES[methodology.toUpperCase()] ?? DEFAULT_CADENCE_SECONDS;
}

export interface StalenessInput {
  projectId: string;
  provider?: string;
  /** ISO timestamp of the last verified report; omit when never verified. */
  lastVerifiedAt?: string | null;
  /** ISO timestamp used as the baseline when no verified report exists. */
  createdAt: string;
  cadenceSeconds: number;
  graceSeconds?: number;
}

export interface StalenessResult {
  projectId: string;
  provider?: string;
  lastVerifiedAt?: string;
  expectedNextReportAt: string;
  /** Seconds since the last verified report (or project creation). */
  stalenessSeconds: number;
  /** True when the project has exceeded its reporting window + grace. */
  isStale: boolean;
}

function parseTimestamp(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Compute the staleness metric for one or more projects: seconds elapsed
 * since the last verified report versus the expected reporting window
 * (cadence + grace). A project with no verified report falls back to its
 * creation timestamp as the baseline.
 */
export function computeStaleness(
  inputs: StalenessInput[],
  now: number = Date.now(),
): StalenessResult[] {
  return inputs.map((input) => {
    const cadence = input.cadenceSeconds > 0 ? input.cadenceSeconds : DEFAULT_CADENCE_SECONDS;
    const grace = input.graceSeconds && input.graceSeconds > 0
      ? input.graceSeconds
      : DEFAULT_GRACE_SECONDS;

    const baseline = input.lastVerifiedAt
      ? parseTimestamp(input.lastVerifiedAt, now)
      : parseTimestamp(input.createdAt, now);

    const expectedNextReportAt = baseline + (cadence + grace) * 1000;
    const stalenessSeconds = Math.max(0, Math.floor((now - baseline) / 1000));

    return {
      projectId: input.projectId,
      provider: input.provider,
      lastVerifiedAt: input.lastVerifiedAt ? new Date(baseline).toISOString() : undefined,
      expectedNextReportAt: new Date(expectedNextReportAt).toISOString(),
      stalenessSeconds,
      isStale: now > expectedNextReportAt,
    };
  });
}
