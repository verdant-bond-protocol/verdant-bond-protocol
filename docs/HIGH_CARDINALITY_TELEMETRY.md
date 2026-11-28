# High-Cardinality Telemetry Protection, Redaction, and Sampling Rules

Resolves **Issue #355**.

## Overview
The Verdant Bond Protocol emits telemetry events covering green bond issuance, coupon distributions, secondary-market settlements, oracle reports, and KYC verification. In high-volume and adversarial scenarios, arbitrary input labels, sensitive secrets, or high request volumes can degrade TSDB/dashboard performance, leak private data, or exhaust telemetry backends.

The `TelemetryService` (`api/src/common/services/telemetry.service.ts`) enforces automated safeguards:
1. **Unsafe Label Rejection & High-Cardinality Bucketing**
2. **Deterministic Sensitive Value Redaction**
3. **Adaptive Volume-Based Sampling with 100% Critical/Error Retention**

---

## 1. High-Cardinality Protection & Label Sanitization

### Label Key Validation
Label keys must conform to regex `^[a-zA-Z_][a-zA-Z0-9_]{0,63}$`.
- Any label containing SQL injection tokens, spaces, semicolons, brackets, or uncurated characters is discarded before reaching metric stores.

### Cardinality Budgeting & Value Clamping
- Each metric label tracks distinct values within an in-memory budget (`maxLabelCardinality`, default `100`).
- When a dimension exceeds the cardinality budget, excess distinct values are mapped to the sentinel bucket `__other__`.
- This prevents metric label explosion in Prometheus/Datadog and keeps dashboard aggregations performant under abusive or uncurated inputs.

---

## 2. Sensitive Data Redaction

Telemetry fields, business metrics, custom payloads, and error strings undergo deep recursive redaction:

| Sensitive Pattern | Match Pattern | Redaction Replacement |
|---|---|---|
| **Stellar Secret Keys** | `/S[A-Z0-9]{55,}/` | `[REDACTED_STELLAR_SECRET]` |
| **JWT & Bearer Tokens** | `/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/` | `[REDACTED_JWT]` |
| **Email Addresses** | `/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/` | `[REDACTED_EMAIL]` |
| **Sensitive Object Keys** | `password`, `secret`, `token`, `apiKey`, `privateKey`, `nationalId`, `passport`, `taxId` | `[REDACTED_SENSITIVE]` |

---

## 3. Sampling Rules & Volume Management

Under normal operations, success events are recorded according to `sampleRateSuccess` (default `1.0` / 100%).

### Critical & Error Invariant
The following are **never sampled out** (100% retention guarantee):
- Any event with `result: 'failure'` or `result: 'partial'`
- Any event carrying an `error` or `errorCode`
- Critical protocol operations:
  - `bond_issuance`
  - `coupon_distribution`
  - `settlement`
  - `governance_vote`
  - `kyc_verification`
  - `oracle_update`

### Adaptive Rate Reduction
- When requests exceed `highVolumeThresholdPerMin` (default `1,000 req/min`), the effective sample rate scales down dynamically:
  $$\text{effectiveRate} = \max\left(0.01, \min\left(\text{baseRate}, \frac{\text{threshold}}{\text{currentVolume}}\right)\right)$$
- Emitted events include `sampleRate` and `isSampled: true` so monitoring platforms can statistically re-weight throughput metrics accurately.

---

## 3b. Deterministic sampling and HTTP labels (contributor slice)

Two additive changes make the safeguards testable and effective on the
automatic HTTP path:

1. **`TelemetryConfig.samplingRandom`** injects the sampling draw (default
   `Math.random`). Tests and incident replays can now assert the exact
   keep/drop decision under adaptive load instead of tolerating a flaky
   assertion. No production behaviour changes when it is omitted.
2. **`TelemetryInterceptor` now attaches bounded labels** (`http_method`,
   `http_route`, `actor_type`). Previously HTTP telemetry carried no labels, so
   the cardinality guards in `TelemetryService` were never exercised by the
   automatic path. The route uses Nest's parametrized `route.path` when
   available; otherwise `normalizeTelemetryRoute()` collapses numeric ids,
   UUIDs, Stellar addresses and opaque hashes/tokens to `:id`, `:uuid`,
   `:address` and `:token`. Query strings are always dropped.

`labels` is an optional field in `TelemetryFields`, so existing consumers are
unaffected. Redaction still runs on label *values* before they are tracked, and
invalid label keys are still discarded.

Tests: `api/src/common/services/telemetry-safeguards.spec.ts` (deterministic
adaptive sampling, route normalization, retry/auth retention) and
`api/src/common/interceptors/telemetry.interceptor.spec.ts` (normal, failure,
authorization and retry paths; 20 distinct bond ids collapse to one route
series).

---

## 4. Failure Modes & Recovery

### Failure Mode 1: Cardinality Clamping Saturating `__other__`
- **Symptom:** Dashboards show 90%+ of metrics in `__other__`.
- **Diagnosis:** An upstream client is sending arbitrary unique strings as a dimension (e.g. client IP or order ID as label).
- **Remediation:** Adjust metric configuration to drop the problematic label from labels map into business metrics, or raise `maxLabelCardinality`.

### Failure Mode 2: Telemetry Ingestion Overload Under Traffic Spike
- **Symptom:** Telemetry sink latency spikes.
- **Diagnosis:** High volume of non-critical success queries.
- **Remediation:** Lower `sampleRateSuccess` via runtime configuration or let adaptive volume reduction downsample automatically. Failures remain 100% captured.

### Failure Mode 3: Route label explodes despite normalization
- **Symptom:** `http_route` approaches `maxLabelCardinality` and clamps to `__other__`.
- **Diagnosis:** A route segment is an unrecognized opaque value (e.g. a new id
  format) or the router pattern is missing on a proxy-generated path.
- **Remediation:** Extend `normalizeTelemetryRoute()` with a placeholder for the
  new segment shape. Existing label sets are rebuilt after the next
  `resetStats()`; dashboards must tolerate one cardinality reset.

### Rollback Procedure
If telemetry configuration changes cause unexpected behavior:
1. Revert to default `TelemetryConfig` with standard 100-cardinality cap and 1.0 sample rate.
2. Call `telemetryService.resetStats()` to clear tracking caches without restarting the application service.
3. To remove the HTTP labels while keeping the rest of the service, drop the
   `labels` field from the two `this.telemetry.emit(...)` calls in
   `TelemetryInterceptor`. This is an additive, backward-compatible field:
   no stored data or downstream contract needs migration.
