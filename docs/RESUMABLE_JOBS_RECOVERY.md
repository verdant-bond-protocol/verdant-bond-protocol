# Resumable Jobs, Dead-Letter Recovery, and Replay Protection

This document describes the additive recovery slice added to the background
worker framework. It covers normal, failure, retry, and authorization paths,
the malformed-payload and replay fixtures, edge cases, rollback behavior, and
the (zero-downtime) migration plan.

Related reading: [WORKER_FRAMEWORK.md](../api/docs/WORKER_FRAMEWORK.md),
[DEPENDENCY_DEGRADATION_MATRIX.md](DEPENDENCY_DEGRADATION_MATRIX.md),
[queue-backpressure.md](queue-backpressure.md),
[DETERMINISTIC_REPLAY.md](runbooks/DETERMINISTIC_REPLAY.md).

## 1. What changed (vertical slice)

| Concern | Where | Behavior |
|---|---|---|
| Payload validation | `api/src/workers/services/job-payload-validation.ts` | Untrusted enqueue payloads are validated before any write. Rejection is `400` with `code: VALIDATION_FAILED` and per-field errors. |
| Replay suppression | `JobQueueService.enqueue` / `persistNewJob` | An optional `idempotencyKey` claims a Redis key with `SET ... NX`. A replay returns the original job; it never creates a second one. |
| Dead-letter recovery | `JobQueueService.recoverDeadLetter` | An admin re-queues an exhausted job with a fresh retry budget (or exactly one more attempt). |
| Stuck-job recovery | `JobQueueService.recoverStuckJobs` | Deterministic sweep of `PROCESSING` jobs whose claim lock has expired. |
| Audit | `job:recovery:audit` (Redis list) | Newest-first record of every recovery, including actor and retry counts. |
| HTTP surface | `JobsController` | Four new admin-only routes (see below). |
| Fixtures / tests | `api/src/test/fixtures/job-payload.fixtures.ts`, `api/src/test/job-recovery.deterministic.spec.ts` | Normal, failure, retry, recovery, malformed, replay, matrix, and authorization coverage. |

## 2. Job lifecycle with recovery

```
                 ┌──────────────── replay of enqueue (same idempotencyKey) ──────┐
                 │                                                              │
PENDING ──claim──> PROCESSING ──success──> SUCCESS (terminal)
   ▲                  │
   │                  ├── failure (retries < maxRetries) ──> PENDING (requeue)
   │                  ├── failure (retries >= maxRetries) ─> DEAD_LETTER
   │                  └── worker crash (lock expires) ──> [stuck sweep] ──┐
   │                                                                       │
   └──────────── admin recoverDeadLetter / recoverStuckJobs ────────────────┘
```

Recovery never mutates a terminal `SUCCESS` job. A `DEAD_LETTER` job is the
only job eligible for explicit recovery; a `PROCESSING` job is eligible for the
automatic sweep only once its lock is gone and its `startedAt` is old enough.

## 3. HTTP API (all recovery routes are admin-only)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/jobs/enqueue` | Enqueue (JWT; non-admin restricted to self-service types). |
| `GET` | `/api/v1/jobs/:jobId` | Inspect a job. |
| `GET` | `/api/v1/jobs/queue/status` | Queue depth + backpressure. |
| `GET` | `/api/v1/jobs/dead-letter/list` | List exhausted jobs. |
| `POST` | `/api/v1/jobs/dead-letter/:jobId/recover` | Re-queue one dead letter. Body: `{ resetRetries?, maxRetries? }`. |
| `POST` | `/api/v1/jobs/recover/stuck` | Sweep interrupted jobs. Body: `{ olderThanMs?, limit? }`. |
| `GET` | `/api/v1/jobs/recovery/audit` | Newest-first recovery audit. |
| `GET` | `/api/v1/jobs/recovery/dependency-matrix` | Dependency fallback matrix + coverage gaps. |

Recovery reads and writes require `JwtAuthGuard` **and** `AdminGuard`. The
route set is registered in `api/src/test/route-authorization.matrix.ts`, so the
authorization-matrix spec fails if a guard is removed or a route is added
without review. The controller derives the audit `actor` from the bearer token,
never from the request body.

## 4. Payload validation and replay fixtures

`validateJobPayload` rejects:

- a payload that is not a plain object;
- missing, non-string, or unknown `type` values;
- `data` that is `null`, an array, cyclic/unserializable, or larger than
  `MAX_JOB_DATA_BYTES` (64 KiB, serialized UTF-8);
- prototype-pollution keys (`__proto__`, `constructor`, `prototype`) in `data`;
- unsafe `correlationId` / `idempotencyKey` values (empty, > 128 chars, or
  containing anything outside `[A-Za-z0-9._:-]`).

`api/src/test/fixtures/job-payload.fixtures.ts` provides deterministic cases
for all of the above plus:

- `replayPayloads` — two different payloads sharing one key; the second must
  return the first job unchanged;
- `expiredReplayPayload` — the same key after the TTL window, which is a
  legitimate new submission;
- `unauthorizedPayload` / `privilegedPayload` — non-admin vs admin enqueue.

The fixture objects are data, not generators, so a failing case reproduces
byte-for-byte.

## 5. Edge cases and rollback behavior

- **Atomic replay claim.** The unique claim is a `SET NX` on
  `job:idem:<key>`. A losing concurrent writer re-reads the reference and
  returns the winner's job. If the marker exists but its job cannot be resolved,
  enqueue fails closed with `503` rather than risking a duplicate side effect.
- **Partial write rollback.** If a job record write fails *after* an
  idempotency claim, the claim is deleted so the caller can safely retry the
  same key. For non-idempotent jobs the pre-existing "keep it in the queue,
  let `dequeue` repair stale refs" behavior is preserved.
- **Dead-letter fail-closed.** `recoverDeadLetter` persists the updated job
  *before* touching the dead-letter and queue sets. If the write fails, the job
  remains a dead letter and the endpoint returns `503`; no audit entry is
  written on that path.
- **No double-claim.** Recovery is serialized by a short Redis lock
  (`job:recovery:lock`). A contended or changed-state recovery returns `409`.
- **Stuck sweep is conservative.** A job is only recovered when its processing
  lock is absent **and** it is at least `olderThanMs` old (default
  `JOB_PROCESSING_TIMEOUT_MS`, 5 minutes). A healthy long-running job keeps its
  lock and is never re-queued. `dequeue()` still independently re-claims jobs
  after the 10-minute lock TTL, so recovery is defense in depth.
- **At-least-once semantics unchanged.** Recovered jobs may re-run; handlers
  must remain idempotent. Recovery increments `recoveryAttempts` but does not
  replay completed side-effect checkpoints from `RecoveryService`.
- **Audit is best-effort.** `lpush`/`lrange` degrade to no-op/empty on Redis
  failure, so an audit outage never blocks a recovery. Audits are capped by the
  read limit; a retention job may prune old entries (see
  [data-retention.md](data-retention.md)).
- **Retry budget edges.** `resetRetries: false` keeps the current count and
  raises `maxRetries` by exactly one, so the recovered job gets one more
  attempt and then dead-letters again if it still fails. An explicit
  `maxRetries <= retries` is a `400`.
- **Kill switch / rollback.** Set `JOB_QUEUE_BACKPRESSURE=off` to restore the
  legacy unbounded admission path. Recovery endpoints remain callable but are
  inert when there are no dead letters or stuck jobs. Disabling replay
  suppression requires callers to stop sending `idempotencyKey`; the field is
  optional and all existing callers keep working unchanged.

## 6. Contract preservation and migration plan

No breaking changes. The migration is a no-op for existing deployments:

1. **Storage** — `Job` gains four *optional* fields (`idempotencyKey`,
   `recoveryAttempts`, `lastRecoveredAt`, `recoveredFrom`) and `JobPayload`
   gains optional `idempotencyKey`. Old records parse and process normally;
   TypeScript `strictNullChecks` callers must treat the new fields as possibly
   `undefined`.
2. **Validation** — previously accepted payloads remain valid. Only payloads
   that were already malformed (unknown type, non-object data, oversized data,
   unsafe keys) are now rejected earlier with a structured `400`.
3. **Routes** — the four new admin routes are additive. Existing clients are
   unaffected; no route paths, verbs, or response shapes changed.
4. **Redis keys** — new keys (`job:idem:*`, `job:recovery:lock`,
   `job:recovery:audit`) are additive. Existing `job:*` keys, sets, and index
   conventions are untouched. The idempotency keys expire after
   `JOB_IDEMPOTENCY_TTL_SECONDS` (default 24 h); stale keys can be purged with
   `SCAN job:idem:*` without affecting correctness (a purged key simply allows
   a new job).
5. **Rollback** — remove the four controller handlers and the recovery calls;
   existing job records remain valid because all new fields are optional. No
   data backfill is required, and no schema version bump is needed.

## 7. Verification

```bash
cd api
npx jest --runInBand \
  src/test/job-recovery.deterministic.spec.ts \
  src/test/route-authorization.matrix.spec.ts \
  src/test/chaos.spec.ts \
  src/workers/services/job-queue.service.spec.ts
```

The deterministic suite uses the seeded chaos harness (frozen clock, manual
TTL clock, seeded fault injection) so a failing scenario replays identically.
It asserts: normal completion, failure→dead-letter, transient retry, dead-letter
recovery (with audit), stuck recovery after lock expiry, fail-closed write
faults, malformed fixtures, replay suppression and TTL expiry, seeded replay
determinism, dependency-matrix completeness, and the admin authorization
boundary.
