/**
 * Pure planning + analysis primitives for the worst-case cardinality / burst
 * load test (issue #403).
 *
 * Keeping the request plan and the statistics pure makes them unit-testable
 * without a running server; the CLI runner in
 * `scripts/load/cardinality-burst.ts` wires them to a real HTTP load
 * generator. See `docs/load-testing.md`.
 */

export interface LoadRequestSpec {
  method: 'GET' | 'POST';
  /** Path including any query string, relative to the target base URL. */
  path: string;
  /** High-cardinality dimensions carried by this request. */
  tags: Record<string, string>;
}

export interface LoadPlanOptions {
  /** Base path to hit, e.g. `/api/v1/bonds`. */
  path?: string;
  /** Distinct tenant/source identifiers to fan cardinality across. */
  tenants?: string[];
  /** Distinct regions/asset classes to fan cardinality across. */
  regions?: string[];
  /** Distinct entity ids used to build unique URLs. */
  ids?: string[];
  /** Distinct page sizes. */
  limits?: number[];
  /** Upper bound on the number of requests in the plan. */
  maxRequests?: number;
}

export const DEFAULT_PLAN_OPTIONS: Required<LoadPlanOptions> = {
  path: '/health',
  tenants: ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d'],
  regions: ['na', 'eu', 'apac', 'latam'],
  ids: Array.from({ length: 8 }, (_, i) => `bond-${i}`),
  limits: [10, 25, 50, 100],
  maxRequests: 200,
};

export interface RequestSample {
  ok: boolean;
  status: number;
  durationMs: number;
}

export interface LoadSummary {
  total: number;
  ok: number;
  errors: number;
  errorRate: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  elapsedMs: number;
  rps: number;
}

export interface LoadThresholds {
  maxErrorRate?: number;
  p95Ms?: number;
  p99Ms?: number;
  minRps?: number;
}

export interface ThresholdResult {
  passed: boolean;
  breaches: string[];
}

/**
 * Build a plan that deliberately maximises label cardinality: every
 * (tenant, region, id, limit) combination produces distinct query values, so
 * the test exercises the telemetry cardinality guards rather than hitting the
 * same cache key repeatedly.
 */
export function buildCardinalityRequests(options: LoadPlanOptions = {}): LoadRequestSpec[] {
  const opts = { ...DEFAULT_PLAN_OPTIONS, ...options };
  const requests: LoadRequestSpec[] = [];

  outer: for (const tenant of opts.tenants) {
    for (const region of opts.regions) {
      for (const id of opts.ids) {
        for (const limit of opts.limits) {
          if (requests.length >= opts.maxRequests) break outer;
          requests.push({
            method: 'GET',
            path: `${opts.path}?tenant=${encodeURIComponent(tenant)}&region=${encodeURIComponent(region)}&id=${encodeURIComponent(id)}&limit=${limit}`,
            tags: { tenant, region, id, limit: String(limit) },
          });
        }
      }
    }
  }

  return requests;
}

/** Nearest-rank percentile of an ascending-sorted array (0..100). */
export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clamped / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index];
}

export function computeSummary(samples: RequestSample[], elapsedMs: number): LoadSummary {
  const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b);
  const ok = samples.filter((s) => s.ok).length;
  const errors = samples.length - ok;
  const totalDuration = durations.reduce((sum, d) => sum + d, 0);
  const safeElapsed = elapsedMs > 0 ? elapsedMs : 1;

  return {
    total: samples.length,
    ok,
    errors,
    errorRate: samples.length === 0 ? 0 : errors / samples.length,
    min: durations.length ? durations[0] : 0,
    p50: percentile(durations, 50),
    p90: percentile(durations, 90),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    max: durations.length ? durations[durations.length - 1] : 0,
    mean: durations.length ? totalDuration / durations.length : 0,
    elapsedMs,
    rps: samples.length / (safeElapsed / 1000),
  };
}

export function evaluateThresholds(
  summary: LoadSummary,
  thresholds: LoadThresholds,
): ThresholdResult {
  const breaches: string[] = [];
  if (thresholds.maxErrorRate !== undefined && summary.errorRate > thresholds.maxErrorRate) {
    breaches.push(
      `errorRate ${summary.errorRate.toFixed(4)} > ${thresholds.maxErrorRate}`,
    );
  }
  if (thresholds.p95Ms !== undefined && summary.p95 > thresholds.p95Ms) {
    breaches.push(`p95 ${summary.p95.toFixed(1)}ms > ${thresholds.p95Ms}ms`);
  }
  if (thresholds.p99Ms !== undefined && summary.p99 > thresholds.p99Ms) {
    breaches.push(`p99 ${summary.p99.toFixed(1)}ms > ${thresholds.p99Ms}ms`);
  }
  if (thresholds.minRps !== undefined && summary.rps < thresholds.minRps) {
    breaches.push(`rps ${summary.rps.toFixed(1)} < ${thresholds.minRps}`);
  }
  return { passed: breaches.length === 0, breaches };
}
