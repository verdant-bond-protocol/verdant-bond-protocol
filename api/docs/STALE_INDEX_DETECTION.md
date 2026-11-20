# Stale-Cache & Stale-Index Detection

> Issue #385 — Stale-cache and stale-index detection with automated repair
> recommendations.

## Overview

`StaleIndexDetectionService.scan(bondIds)` inspects every supplied bond ID for
two independent health signals:

1. **Stale durable index** — `lastReconciled` timestamp has exceeded the
   configured staleness threshold (default 60 min).
2. **Cold Redis cache** — The `bond:{id}:holders` Redis set is absent or empty,
   meaning read operations will fall through to the slower durable store.

Each finding is annotated with a `repairAction` — a structured object that
names the operator command to run, describes the effect, and flags whether the
repair can be automated.

## Severity Levels

| Severity | Condition | Health impact |
|----------|-----------|---------------|
| `UNSEEDED` | `lastReconciled == 0` (never seeded) | **CRITICAL** — coupon distribution blocked |
| `STALE` | `ageMs > HOLDER_INDEX_MAX_STALENESS_MS` | **CRITICAL** — coupon distribution blocked in strict mode |
| `WARNING` | `ageMs > HOLDER_INDEX_WARNING_MS` **or** Redis cache empty | **DEGRADED** |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOLDER_INDEX_MAX_STALENESS_MS` | `3600000` (60 min) | Age at which an index is STALE |
| `HOLDER_INDEX_WARNING_MS` | `1800000` (30 min) | Age at which an index enters WARNING |
| `HOLDER_INDEX_STRICT` | `true` | Block coupon distribution on stale index |

## Repair Actions

### UNSEEDED bond
```
reindex --bond-id <id>
```
The holder index has never been populated.  Run the reindex script
(`api/scripts/reindex-holders.ts`) with the target bond ID.  This requires
operator sign-off before the first coupon distribution.

**Automatable**: ❌ — requires explicit operator action.

### STALE bond
```
reconcile --bond-id <id> --all-known
```
The durable index is older than the staleness threshold.  Enqueue a
`RECONCILIATION` job via the worker framework or call
`HolderIndexService.reconcileBond(bondId)` directly.

**Automatable**: ✅ — safe to schedule via the job queue.

### WARNING — cold Redis cache
```
warm-cache --bond-id <id>
```
The durable index is fresh but the Redis set is empty (evicted or never
warmed).  Re-populate by calling `redis.sAdd(bond:${bondId}:holders, …)` from
the authoritative holder list.  A full reconciliation is not needed.

**Automatable**: ✅ — low risk, no on-chain calls required.

## Failure Modes & Edge Cases

### Redis unavailable during scan
The scan degrades gracefully: a Redis error is caught, the bond is counted as
`staleCacheCount`, and the finding is promoted to at least `WARNING`.  The
durable-index check is unaffected.

### Concurrent reconciliation during scan
The scan is read-only and does not take locks.  A concurrent reconciliation may
update `lastReconciled` between two scan iterations, causing a bond to appear
healthy in the report even though it was stale at scan start.  This is
acceptable — the report is a point-in-time snapshot.

### bondIds list is empty
The service returns an `OK` report with zero findings immediately.

## Rollback / Recovery Steps

1. Run `scan([...allBondIds])` to get the current health report.
2. For each `CRITICAL` finding, execute the `repairAction.command`.
3. Re-run `scan` to confirm health returns to `OK`.
4. If a reconciliation job is stuck in DEAD_LETTER, inspect via
   `GET /jobs/dead-letter/list` and re-enqueue after fixing the root cause.
