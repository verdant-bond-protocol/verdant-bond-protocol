# Stale-Cache Detection with Repair Recommendations (#531)

Code: `api/src/common/services/stale-cache-detector.service.ts`
Tests: `api/src/common/services/stale-cache-detector.service.spec.ts`

`BoundedCacheService` (#422) knows an entry's age but not whether it is still
**correct**, and `refresh()` will extend the TTL of a value that is already
wrong. `StaleCacheDetectorService` compares live entries with their source of
truth. (Holder-index staleness has its own detector:
[STALE_INDEX_DETECTION.md](../api/docs/STALE_INDEX_DETECTION.md).)

```ts
const report = await detector.scan(cache, { load: (key) => repo.find(key) });
// report.health: OK | DEGRADED | CRITICAL
const outcomes = await detector.repair(cache, source, report, actor, { dryRun: true });
```

## Classification

| Status | Detected when | Recommendation | Automatable |
|---|---|---|---|
| `stale_version` | entry `metadata.version` ≠ source `version` | `reload` | yes |
| `stale_value` | no versions on both sides and values differ (key order ignored) | `reload` | yes |
| `orphaned` | source returns `null` | `evict` | yes |
| `source_unavailable` | source lookup throws | `retry_scan` | no |

When both sides carry a version, versions win: equal versions are fresh even
if the value representation differs. Expired entries are skipped (they are
already misses). When at least `prefixThreshold` (default 10) stale entries
share a `prefix:`, the report suggests `invalidatePrefix(prefix)` and an audit of
that prefix's write-path invalidation.

Health is `CRITICAL` when stale + orphaned entries reach `criticalRatio`
(default 50%) of scanned entries, `DEGRADED` for any finding, `OK` otherwise.

## Repair

- Requires an actor holding `REPAIR_CACHE`; otherwise `CacheRepairForbiddenError`
  is thrown and nothing changes.
- `dryRun: true` reports `planned` outcomes without touching the cache.
- The source is **re-read at repair time**. A record that reappeared since the
  scan is reloaded, not evicted.
- Entries evicted since the scan, and non-automatable findings, are `skipped`.
- A source failure during repair leaves the entry untouched (`failed`). Evicting
  it would turn one outage into a stampede of misses, and its TTL still bounds
  it. Retry with a fresh scan once the source recovers.

## Compatibility

Additive: `BoundedCacheService` is unchanged. Callers that store a version in
entry metadata (`set(key, value, ttl, { version })`) get version-based
detection; others get value comparison.
