# Dependency Degradation Matrix and Fallback Behavior

The matrix is executable documentation: it lives in
`api/src/workers/services/dependency-fallback.ts` and is exposed at
`GET /api/v1/jobs/recovery/dependency-matrix` (admin-only). The pure
`decideFallback(dependency, state, context)` function is the single source of
truth for what the worker should do when a dependency is impaired.

## States

`DependencyState` (from the health module): `operational`, `degraded`, `down`,
`unknown`. Unknown/unmapped pairs always **fail closed** — a missing rule is
never treated as "healthy".

## Strategies

| Strategy | Meaning |
|---|---|
| `proceed` | Normal operation; no special handling. |
| `retry` | Re-queue with exponential-ish backoff; keep the job alive. |
| `fallback` | Use an alternate source (`fallback-gateways`, `local-cache`). |
| `degrade` | Continue with reduced guarantees; serve cached reads; defer on-chain effects. |
| `fail_closed` | Reject/stop rather than risk losing or double-applying work. |
| `reject` | Explicitly refuse the request to the caller. |

## Matrix

| Dependency | Effect on | operational | degraded | down | unknown |
|---|---|---|---|---|---|
| **redis** (job queue) | all job types | proceed · retry×3 · 500 ms | retry×3 · 1 s | **fail closed** (reject new work; never shed an admitted job) | fail closed |
| **rpc** (Stellar/Horizon) | reconciliation, coupon distribution, oracle sync | proceed · retry×3 · 1 s | retry×5 · 2 s + probe before on-chain resubmit | degrade · retry×5 · 5 s (queue work, serve cached reads) | retry×3 · 2 s + probe |
| **ipfs** (gateways) | data export | proceed · retry×2 · 500 ms | fallback `fallback-gateways` · retry×2 | fallback `local-cache` · no retry | fallback `fallback-gateways` · retry×2 |
| **postgres** (durable store) | all job types | proceed · retry×2 · 500 ms | retry×3 · 1 s (keep job queued) | **fail closed** (do not mark success) | fail closed |

`maxRetries` can be overridden per decision (e.g. an admin recovery re-queue)
without mutating the matrix. `matrixGaps()` returns any dependency/state pair
without a rule; the test suite asserts it is empty.

## Normal / failure / retry / authorization coverage

- **Normal** — `operational` rows return `proceed`; jobs are enqueued and run
  unchanged.
- **Failure** — `down` rows choose `fail_closed` (redis, postgres), `degrade`
  (rpc), or `fallback` (ipfs), each with a user-safe message.
- **Retry** — `degraded` rows carry a retry budget and backoff used by the
  worker; recovered jobs retain their correlation id for tracing.
- **Authorization** — the matrix view is behind `JwtAuthGuard` + `AdminGuard`;
  the route-authorization matrix spec verifies the wiring, and the
  deterministic spec verifies non-admin requests get `401`.

## Edge cases and rollback

- **Unknown dependency or state** → fail closed with `maxRetries: 0`, empty
  `affectsJobTypes`, and no throw. A new dependency must be added to the matrix
  explicitly before it participates in fallback decisions.
- **Health indicator throws** → `HealthService.getReport()` records the
  dependency as `down`, which maps to the conservative `down` rule above.
- **Degrade-only Redis ops** (`get`, `sMembers`, `lpush`, `lrange`, `setNxValue`)
  return null/empty/false on failure; enqueue then fails closed through the
  idempotency guard rather than double-enqueueing. Critical ops
  (`getOrThrow`, `sMembersOrThrow`, `acquireLockOrThrow`) surface errors so
  jobs are never silently dropped.
- **Rollback** — the matrix is data and a pure function; removing the
  `GET .../dependency-matrix` handler and deleting the service file has no
  effect on job processing. Workers can keep using their existing retry logic.
- **Adding a dependency** — add a `Record<DependencyState, MatrixRule>` entry
  plus a health indicator; `matrixGaps()` will flag missing states until the
  entry is complete.

Verification:

```bash
cd api
npx jest --runInBand src/test/job-recovery.deterministic.spec.ts
```
