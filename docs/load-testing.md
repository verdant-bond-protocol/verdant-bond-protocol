# Load testing: worst-case cardinality and burst traffic

Issue: [#403](https://github.com/verdant-bond-protocol/verdant-bond-protocol/issues/403)

A reproducible load test that drives the API with **worst-case metric
cardinality** — every request carries distinct `tenant`/`region`/`id`/`limit`
values — under a **burst** concurrency pattern, so telemetry-cardinality and
cache guards are exercised rather than one hot key.

## Pure plan + analysis

`api/src/ops/load/load-test-plan.ts` contains the testable core:

- `buildCardinalityRequests()` — expands the cross-product of cardinality
  dimensions into request specs, bounded by `maxRequests`.
- `computeSummary()` — totals, error rate, nearest-rank p50/p90/p95/p99, mean,
  max, throughput.
- `evaluateThresholds()` — compares a summary against latency/error/throughput
  bounds and returns the breached bounds.

These are unit-tested in `load-test-plan.spec.ts` and run as part of
`npm run test`.

## Running the Node runner

Dependency-free (Node `http`/`https`), so it runs anywhere the API runs:

```bash
npm run load:cardinality -- \
  --url=http://localhost:3000 \
  --path=/api/v1/bonds \
  --concurrency=50 \
  --requests=1000 \
  --max-error-rate=0.01 \
  --p95=500 \
  --p99=1000 \
  --min-rps=100
```

The runner prints a JSON summary and a `PASS`/`FAIL` line, and exits non-zero
when any threshold is breached — suitable for CI gating.

Environment fallbacks: `TARGET_URL`, `LOAD_PATH`, `LOAD_CONCURRENCY`,
`LOAD_REQUESTS`, `LOAD_TIMEOUT_MS`, `LOAD_MAX_ERROR_RATE`, `LOAD_P95_MS`,
`LOAD_P99_MS`, `LOAD_MIN_RPS`.

## Running the k6 scenario

For sustained/burst arrival-rate testing with Grafana k6:

```bash
BASE_URL=http://localhost:3000 k6 run scripts/load/k6-cardinality-burst.js
```

The scenario ramps from 50 to 500 req/s and back, with thresholds on failure
rate and p95/p99 latency.

## What "worst-case cardinality" means

Each request uses a unique query-value combination, so the server must handle
many distinct label sets simultaneously. This is the condition under which
per-series limits, aggregation/reduction rules, and cache-key explosion show
up. Watch for:

- series-count runaway / dropped samples in telemetry, and
- a rising error rate or latency tail as cardinality grows.

## Interpreting results and thresholds

- `errorRate` — 4xx/5xx and transport failures count as errors (only `2xx`/`3xx`
  are `ok`).
- `p95`/`p99` — tail latency; the burst stages typically move these first.
- `rps` — effective throughput; compare against the threshold to detect
  saturation.

Suggested initial gates: `max-error-rate <= 0.01`, `p95 <= 500ms`,
`p99 <= 1000ms`. Tighten once a baseline is established on the target
environment.

## Non-goals

This harness does not provision infrastructure or seed data. Run it against a
representative environment (staging) with production-like data volume; results
from an empty database are not meaningful.
