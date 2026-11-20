# Risk-Scored Abuse Detection

The public Verdant Bond Protocol API scores opted-in high-impact operations so
that abusive or anomalous traffic can be slowed down or reviewed **without**
blocking legitimate low-risk use.

The single source of truth is
[`api/src/common/risk`](../api/src/common/risk).

## How it works

1. A controller action opts in with `@RiskScored({ operation, amountFields? })`.
2. `RiskGuard` collects lightweight behavioural signals (notional amount,
   velocity, KYC status, recent rejections, origin change) and calls
  `RiskService.assess()`.
- Low risk → the request proceeds and the response carries `x-risk-score` and
  `x-risk-band`.
- Elevated risk → the request is rejected with `401 STEP_UP_REQUIRED` unless
  the caller presents an `x-risk-step-up-token`.
- High risk → the caller receives `403 RISK_REVIEW_REQUIRED`, and the attempt
  is recorded so a repeat escalates faster.

Endpoints without `@RiskScored` are never scored, so the guard is safe to
register globally and legitimate low-risk traffic is untouched.

## Signals

| Signal | Default weight | Meaning |
| --- | --- | --- |
| `amount_watch` | 8 | Notional ≥ half the step-up amount |
| `amount_elevated` | 20 | Notional ≥ `RISK_AMOUNT_STEP_UP_USD` |
| `amount_critical` | 35 | Notional ≥ `RISK_AMOUNT_REVIEW_USD` |
| `velocity_elevated` | 15 | ≥ `RISK_VELOCITY_STEP_UP` ops in the window |
| `velocity_critical` | 30 | ≥ `RISK_VELOCITY_REVIEW` ops in the window |
| `new_actor` | 8 | First operation seen for the actor |
| `kyc_unverified` | 20 | Actor has no verified KYC record |
| `recent_rejections` | 10 each (max 30) | Prior rejections in the window |
| `origin_changed` | 10 | Network origin changed since last op |
| `critical_operation` | 10 | Operation is in `CRITICAL_OPERATIONS` |

Scores are clamped to `0..100`. `band`/`action` are derived from
`stepUpThreshold` (default 40) and `reviewThreshold` (default 75):

- `score < 40` → `allow` / `low`
- `40 ≤ score < 75` → `step_up` / `elevated`
- `score ≥ 75` → `review` / `high`

## Configuration

All thresholds are environment-overridable. Set `RISK_DETECTION_ENABLED=false`
to disable scoring entirely (the primary rollback lever, no redeploy needed).

| Env var | Default |
| --- | --- |
| `RISK_DETECTION_ENABLED` | `true` |
| `RISK_WINDOW_SECONDS` | `60` |
| `RISK_STEP_UP_THRESHOLD` | `40` |
| `RISK_REVIEW_THRESHOLD` | `75` |
| `RISK_AMOUNT_STEP_UP_USD` | `10000` |
| `RISK_AMOUNT_REVIEW_USD` | `100000` |
| `RISK_VELOCITY_STEP_UP` | `5` |
| `RISK_VELOCITY_REVIEW` | `10` |

## Observability

- Response headers `x-risk-score` and `x-risk-band` are always set for scored
  operations so clients and support can correlate.
- A satisfied step-up is marked with `x-risk-step-up: satisfied`.
- Rejections surface through the stable problem-details taxonomy:
  `STEP_UP_REQUIRED` (401) and `RISK_REVIEW_REQUIRED` (403), each carrying the
  assessment under `context` (score, band, reasons).

## Operational edge cases & failure modes

- **Fresh service / restart**: velocity counters are in-process, so they reset
  on restart. This is an intentional dependency-free slice; it degrades to
  "everyone is a new actor" rather than failing closed.
- **Missing amount**: endpoints that cannot resolve a notional default to `0`,
  so the amount signals simply do not fire. KYC and velocity signals still
  apply.
- **No KYC provider**: `kyc_unverified` fires until a verified record exists;
  configure `RISK_AMOUNT_*` upward if this over-flags a legitimate cohort.
- **A false-positive spike**: set `RISK_DETECTION_ENABLED=false` to bypass all
  scoring immediately.

## Rollback / recovery

1. Set `RISK_DETECTION_ENABLED=false` (instant, config-only).
2. If a single endpoint is the problem, remove its `@RiskScored` decorator in a
   follow-up deploy.
3. Re-enable only after tuning the relevant threshold with
   `RiskService.configure()` in a staging run.

## Verification

- `api/src/common/risk/risk-scorer.spec.ts`
- `api/src/common/risk/risk.service.spec.ts`
- `api/src/common/risk/risk.guard.spec.ts`
