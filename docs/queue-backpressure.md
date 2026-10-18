# Bounded queue backpressure for background work (#391)

`JobQueueService.enqueue` used to accept every job. One user clicking
"export" in a loop, or a burst of reconciliation requests, could grow
`job:queue` without limit and starve the single worker loop of coupon and
oracle work. Admission is now bounded at enqueue time.

Code: `api/src/workers/services/queue-backpressure.ts` (policy) and
`api/src/workers/services/job-queue.service.ts` (admission).
Tests: `api/src/workers/services/queue-backpressure.spec.ts`, plus the replay
suite in `api/src/test/replay/` (#390).

## Bounds

Every enqueue is checked against three bounds, tightest first:

| Scope | Counts | Applies to |
|-------|--------|-----------|
| `user` | pending jobs of this type submitted by this caller | non-privileged callers |
| `type` | pending jobs of this type | everyone (privileged callers get `adminReserve` extra) |
| `global` | pending jobs of every type | everyone (privileged callers get `JOB_QUEUE_ADMIN_RESERVE` extra) |

Defaults:

| Type | `maxDepth` | per user | admin reserve | Retry-After |
|------|-----------:|---------:|--------------:|------------:|
| `data_export` | 100 | 3 | 10 | 60 s |
| `reconciliation` | 5 | 1 | 2 | 300 s |
| `portfolio_rebalance` | 200 | 5 | 10 | 30 s |
| `oracle_sync` | 50 | 5 | 10 | 60 s |
| `coupon_distribution` | 500 | 50 | 50 | 30 s |
| global | 1000 | — | 50 | — |

"Pending" means not yet terminal: `pending` and `processing` jobs both count.

### Configuration

| Variable | Effect |
|----------|--------|
| `JOB_QUEUE_BACKPRESSURE=off` | Kill switch: enqueue is unbounded again, as before #391 |
| `JOB_QUEUE_MAX_DEPTH` | Global bound |
| `JOB_QUEUE_ADMIN_RESERVE` | Global privileged headroom |
| `JOB_QUEUE_MAX_DEPTH_<TYPE>` | Type bound, e.g. `JOB_QUEUE_MAX_DEPTH_DATA_EXPORT=50` |
| `JOB_QUEUE_USER_MAX_DEPTH_<TYPE>` | Per-user bound for a type |

A missing, negative or non-integer value keeps the default. A typo can
therefore never remove a bound.

## Responses

A rejected enqueue persists nothing and returns:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
Content-Type: application/json

{ "code": "QUEUE_BACKPRESSURE", "retryable": true, "status": 429, ... }
```

The client may retry the same request unchanged after `Retry-After`.
`QUEUE_BACKPRESSURE` is a stable code in `ErrorTaxonomy`. The RFC 7807 filter
now honours a known `code` and a `retryAfterSeconds` on any `HttpException`.

`GET /api/v1/jobs/queue/status` (admin) keeps `size` and adds `backpressure`:
global and per-type `depth`, `maxDepth`, `adminReserve` and `saturated`.

## Authorization

- `POST /api/v1/jobs/enqueue`: the job's `userId` (the budget owner) is
  always taken from the bearer token. A caller can no longer spend another
  user's budget by putting their id in the body.
- Non-admins may enqueue only `data_export` and `portfolio_rebalance`. The
  other types move money or rewrite shared state, so they now return `403`
  unless the caller is the admin wallet. They are already enqueued by
  admin-only routes, for example `POST /api/v1/reconciliation/enqueue-job`.
- Admin routes enqueue with `{ privileged: true }`. Privileged jobs skip the
  per-user bound and may use the reserve. Operators can still run
  reconciliation or recovery work while user traffic has filled the queue.

## Retry semantics

Only **admission** is bounded. An admitted job is never shed.
`markFailure` re-queues a retry without passing admission again. A saturated
queue therefore delays new work but never drops work it already accepted.
Dead-lettering is unchanged.

## Operational edge cases

| Situation | Behaviour |
|-----------|-----------|
| Redis read fails during admission | Fails **closed** with `503`. An unreadable depth is never treated as "empty". `sMembersOrThrow` exists for this. |
| Two API instances enqueue at once | Admission runs under one short Redis lock (`job:admission:lock`, `PX` 5 s). Concurrent instances cannot jointly overshoot a bound. A contended lock is retried 5 × 20 ms, then answers `429` with scope `contended` and `Retry-After: 1`. |
| Instance crashes while holding the admission lock | The lock self-expires after 5 s. Until then, enqueues answer `429 contended`. |
| Index cleanup write lost (crash between the terminal write and `sRem`) | Indexes are cleaned up best-effort. When a bound is hit, admission first prunes ids whose record is missing or terminal, then re-checks. A stale entry can delay admission but never block it permanently. |
| Job record expired (7-day TTL) while still indexed | Same pruning path. |
| Export rejected by backpressure | `POST /api/v1/exports/request` cancels the export record it just created, so no `pending` export is left without a job. |
| Bounds lowered below the current depth | Nothing already queued is dropped. New work is rejected until the queue drains below the new bound. |

## Rollout and rollback

1. Deploy with the defaults. Watch `GET /api/v1/jobs/queue/status` and the
   rate of `QUEUE_BACKPRESSURE` responses.
2. Tune a type with `JOB_QUEUE_MAX_DEPTH_<TYPE>` without a code change.
3. **Rollback**: set `JOB_QUEUE_BACKPRESSURE=off` and restart. Enqueue is
   unbounded again. The new index keys (`job:queue:type:*`, `job:queue:user:*`)
   are then written but ignored, and are safe to leave or delete with
   `DEL job:queue:type:* job:queue:user:*`.
4. **Migration**: none. Jobs enqueued before this change have no index
   entries, so for one drain cycle they do not count towards type and user
   bounds. They still count towards the global bound, which reads `job:queue`
   directly. No backfill is needed.
