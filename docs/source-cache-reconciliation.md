# Source / Cache Reconciliation (#507)

Read paths serve bonds, holders, and projects from caches filled from the
authoritative source (contract state, project registry). A missed
invalidation or a half-written cache update drifts silently. Source/cache
reconciliation detects that drift, plans a repair, and applies it safely.

Code: [`api/src/reconciliation/services/cache-reconciliation.ts`](../api/src/reconciliation/services/cache-reconciliation.ts)
Tests: `api/src/reconciliation/services/cache-reconciliation.spec.ts`

## Flow

```text
loadSource() ─┐
              ├─► diffSourceAndCache() ─► drifts + plan ─► applyCacheRepairPlan()
loadCache()  ─┘                              │                (dry-run by default)
                                             └─► toReconciliationReport()
```

1. **Diff** — every key is compared by version (when both sides have one)
   and by a key-order-independent SHA-256 of the value.
2. **Plan** — `set` for missing/stale keys, `delete` for orphans. Source wins.
3. **Apply** — dry-run unless `dryRun: false`; retried and journalled.

### Drift classification

| Drift | Condition | Planned repair |
| --- | --- | --- |
| `missing` | key in source, not in cache | `set` from source |
| `stale` | value digest differs, cache version behind, or cache holds the key twice | `set` from source |
| `orphaned` | key in cache, not in source | `delete` |
| `inconsistent` (HIGH) | cache version **ahead** of source | **none** — report only |
| `duplicate` (HIGH) | source returned the key twice | **none** — report only |

A cache ahead of source usually means the source read lagged (indexer or
replica behind). Repairing would roll the cache *backwards*, so it is never
automated; verify source freshness first. A duplicated source key means the
source itself is ambiguous, so the cache is left alone.

## Retry behaviour

Each cache `get` (journal read) and `set`/`delete` is retried up to
`maxAttempts` (default 3, max 10) with doubling backoff from `baseDelayMs`
(default 50ms). An error carrying `retryable: false` (e.g. a Redis `NOPERM`)
is not retried. `result.retries` reports the total retries spent.

## Rollback / recovery

Before writing a key, its prior cached entry is journalled. If any action
still fails after retries, every action already applied is reverted newest
first — restoring the prior entry, or deleting a key that did not exist —
and the result is `rolled-back` with `applied: 0`. The cache is then exactly
as it was before the run, and the run can simply be retried.

If a revert itself fails, the status is `rollback-failed` and
`unrestoredKeys` lists the affected keys. Recovery: evict those keys (the
next read repopulates them from source) and re-run reconciliation. Because
source is authoritative, evicting a cache key is always safe.

## Authorization

`applyCacheRepairPlan` requires `Permission.RECONCILE_CACHE` — even for a
dry-run, since the plan enumerates cached values — and throws
`CacheRepairForbiddenError` otherwise. The permission is new and additive:
`MAINTAINER` holds it (all permissions) and it is granted to
`SETTLEMENT_MANAGER` alongside `RECONCILE_HOLDERS`. Issuers and investors do
not have it. Detection through `ReconciliationService` stays behind the
existing admin-only `api/v1/reconciliation` routes.

## Using it with the existing reconciliation flow

```ts
reconciliationService.registerInvariant(
  cacheReconciliationInvariant('bond', loadBondsFromSource, loadBondsFromCache),
);
```

The invariant (`CACHE_CONSISTENCY_BOND`) returns ordinary
`ReconciliationDrift`s, so `POST /api/v1/reconciliation/dry-run` and the
reconciliation job include cache drift with no contract change. A loader
that throws becomes an `inconsistent` drift via the existing service error
handling, never a crashed run.

## Compatibility

No existing interface changes. `ReconciliationDrift`/`ReconciliationReport`
are reused as-is; the only shared-code change is the additive
`RECONCILE_CACHE` permission.
