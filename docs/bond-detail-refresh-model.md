# Bond Detail Refresh Model (issue #4)

## Problem

After a mutation (subscribe, transfer, claim, mature, sweep) the bond detail
view previously refreshed only the bond summary with a second `GET /bonds/:id`
call, leaving the holders list, coupon undistributed total, and maturity status
stale. A user could see a mix of pre- and post-mutation data across panels.

## Solution

### API — atomic detail snapshot

`GET /bonds/:id/detail` (`BondsController.getBondDetail`,
`BondsService.getBondDetail`) returns a single, atomically-fetched payload:

```ts
interface BondDetailResponse {
  bond: BondResponse;
  holders: HolderResponse[];
  coupon: { undistributedTotal: string };
  maturity: { reached: boolean; date: number; secondsUntil: number };
  loadedAt: string; // server timestamp for staleness detection
}
```

The bond summary, holders, and coupon total are fetched together and the
maturity status is derived once, so the response can never contain a mix of
pre- and post-mutation values. The endpoint sends `Cache-Control: no-cache` and
the body carries `loadedAt` so clients can detect staleness.

### Frontend — reload coordinator

`BondDetailReloadCoordinator` (provided per `BondDetailComponent`) owns:

- `detail` — the single committed snapshot.
- `loading` / `sectionLoading` — per-panel loading flags (bond, holders, coupon,
  maturity) toggled together for one atomic refresh.
- `lastLoadedAt` — the server `loadedAt` timestamp (used by `isNewerThan`).
- `reload(id)` — cancels any in-flight reload, fetches `/detail`, and commits the
  new snapshot only after the response arrives.

`BondDetailComponent` derives **every** panel from `coordinator.detail()`
(`bond`, `holders`, `undistributed`, `maturityReached`). Every mutation handler
and the manual "Refresh" button call `reload(id)`, so all panels refresh together
and never show interleaved old/new state.

### Tests

- `bonds.detail.service.spec.ts` — atomic snapshot, maturity-reached derivation,
  consistent re-fetch on every reload (no service-side caching that could serve
  stale data).
- `bond-detail.reload-coordinator.spec.ts` — per-section loading flags toggle
  together, staleness detection via `isNewerThan`, and a newer reload cancels the
  previous in-flight one.
- `bond-detail.component.spec.ts` — init loads via the coordinator, holders panel
  renders from the snapshot, and subscribe / transfer / claim / manual-refresh all
  trigger a fresh `getBondDetail`.
