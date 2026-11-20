import {
  buildCardinalityRequests,
  computeSummary,
  evaluateThresholds,
  percentile,
  RequestSample,
} from './load-test-plan';

describe('buildCardinalityRequests', () => {
  it('generates unique high-cardinality URLs across every dimension', () => {
    const requests = buildCardinalityRequests({ tenants: ['a', 'b'], regions: ['na'], ids: ['x'], limits: [10, 20] });

    expect(requests).toHaveLength(4);
    const paths = new Set(requests.map((r) => r.path));
    expect(paths.size).toBe(4);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      tags: { tenant: 'a', region: 'na', id: 'x', limit: '10' },
    });
    expect(requests[0].path).toContain('/health?tenant=a&region=na&id=x&limit=10');
  });

  it('respects maxRequests as an upper bound', () => {
    const requests = buildCardinalityRequests({ maxRequests: 5 });
    expect(requests).toHaveLength(5);
  });

  it('uses configurable base path', () => {
    const requests = buildCardinalityRequests({ path: '/api/v1/bonds', maxRequests: 1 });
    expect(requests[0].path.startsWith('/api/v1/bonds?')).toBe(true);
  });
});

describe('percentile', () => {
  it('returns 0 for an empty sample', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('uses nearest-rank semantics', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
  });
});

describe('computeSummary', () => {
  it('aggregates counts, percentiles, and throughput', () => {
    const samples: RequestSample[] = [
      { ok: true, status: 200, durationMs: 10 },
      { ok: true, status: 200, durationMs: 20 },
      { ok: true, status: 200, durationMs: 30 },
      { ok: false, status: 503, durationMs: 40 },
    ];

    const summary = computeSummary(samples, 2000);

    expect(summary.total).toBe(4);
    expect(summary.ok).toBe(3);
    expect(summary.errors).toBe(1);
    expect(summary.errorRate).toBe(0.25);
    expect(summary.min).toBe(10);
    expect(summary.max).toBe(40);
    expect(summary.p50).toBe(20);
    expect(summary.p95).toBe(40);
    expect(summary.rps).toBe(2);
  });

  it('handles an empty sample set without dividing by zero', () => {
    const summary = computeSummary([], 0);

    expect(summary.total).toBe(0);
    expect(summary.errorRate).toBe(0);
    expect(summary.p99).toBe(0);
    expect(summary.rps).toBe(0);
  });
});

describe('evaluateThresholds', () => {
  const summary = computeSummary(
    [
      { ok: true, status: 200, durationMs: 10 },
      { ok: true, status: 200, durationMs: 20 },
      { ok: false, status: 500, durationMs: 900 },
    ],
    1000,
  );

  it('passes when every bound is met', () => {
    expect(evaluateThresholds(summary, { maxErrorRate: 0.5, p99Ms: 1000, minRps: 1 })).toEqual({
      passed: true,
      breaches: [],
    });
  });

  it('reports each breached bound', () => {
    const result = evaluateThresholds(summary, { maxErrorRate: 0.1, p95Ms: 100, minRps: 100 });

    expect(result.passed).toBe(false);
    expect(result.breaches).toHaveLength(3);
    expect(result.breaches.join(' ')).toContain('errorRate');
    expect(result.breaches.join(' ')).toContain('p95');
    expect(result.breaches.join(' ')).toContain('rps');
  });
});
