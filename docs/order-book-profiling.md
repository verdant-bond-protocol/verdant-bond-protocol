# Order-Book Depth Profiling (issue #208)

Component: `frontend/src/app/marketplace/order-book-depth/order-book-depth.component.ts`
(`<app-order-book-depth>` embedded in the marketplace list).

## Design (why it stays cheap)

- `ChangeDetectionStrategy.OnPush` + signals: the view re-renders only when the
  `asks` signal is set. No zone-triggered row updates.
- Immutable snapshots: `aggregateDepth()` builds a fresh `DepthLevel[]` per
  flush; rows use `@for (...; track level.price)` so Angular reuses DOM nodes
  for unchanged price levels instead of re-creating the table.
- Burst batching: every inbound update (poll or `ingest()` push) keeps only the
  latest snapshot and applies it once per `requestAnimationFrame`. N updates in
  one frame cost exactly one signal set → one change-detection pass
  (`flushCount` exposes this counter).
- Aggregation is O(n) in open orders, capped at `DEPTH_MAX_LEVELS = 20` rows.

## Measurements

Simulated high-frequency scenario (karma spec
`order-book-depth.component.spec.ts`, "batches a rapid burst"):

| Scenario | Inbound updates | Snapshot flushes (CD passes) |
|---|---|---|
| 50-order burst inside one frame | 50 | **1** |
| Idle poll tick, book unchanged | 1 | 1 (same-shape immutable snapshot; DOM diff is a no-op via trackBy) |
| 2 consecutive stream failures | 0 | 0 + stale/reconnecting badge shown |
| Reconnect backfill | 1 | 1 (full snapshot replaces missed deltas) |

How to reproduce: `npm test -- --watch=false --browsers=ChromeHeadless`
in `frontend/` (spec asserts `flushCount` deltas above), or observe
`flushCount` vs. network update count in devtools during a trading burst.

## Disconnect behavior

`DEPTH_STALE_AFTER_FAILURES = 2` consecutive failures → visible
"Reconnecting… showing last known depth" badge (last snapshot stays on
screen, never blanked); `reconnect()` performs a full backfill and clears
the badge on the next successful snapshot.
