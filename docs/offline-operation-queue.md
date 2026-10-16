# Conflict-Aware Offline / Multi-Tab Operation Queue (#381)

`OperationQueueService` (`frontend/src/app/shared/services/operation-queue.service.ts`)
holds bond **subscribe** and **transfer** operations that could not be sent: the browser
was offline, or an attempt got no definitive answer. It sends them later, without
duplicates, and only while the bond still matches what the user saw.

## Guarantees

| Requirement | How |
|---|---|
| Survives refresh/disconnect | State lives in `localStorage['nbs_operation_queue']` (`{ nextSeq, ops[] }`). A new page load reads it back and drains it. |
| No duplicate execution | Each operation's id **is** its `Idempotency-Key`. The bond page sends its first attempt with that key, and the queue reuses it on every replay, so the API's idempotency layer (`docs/idempotency.md`) returns the original result if an earlier attempt already ran. |
| Multi-tab safe | Every tab sees the same queue through `storage` events. Sending is serialised across tabs by an exclusive Web Lock (`navigator.locks`). Each run re-reads storage before each operation, so work another tab has sent or discarded is skipped. |
| Detects stale state | Before sending, the queue re-reads `GET /api/bonds/:id/detail` and compares it with the operation's basis (see below). |
| Deterministic choices | Operations are sent strictly in `seq` order, with ties broken by id. An operation that stops (`conflict` or `failed`) blocks later operations for the **same bond and wallet** until the user picks **Retry** or **Discard**. Other bonds keep flowing. |

## States

```
            enqueue
               │
               ▼
 ┌────────► queued ──── send OK ────► (removed; tx tracked by PendingTransactionsService)
 │             │ │
 │   transient │ │ stale / invalid / rejected
 │   (stays)   │ ▼
 │             │ conflict | failed ── discard ──► (removed)
 │             │     │
 └──── retry ──┴─────┘
```

- **Transient** (stays `queued`, retried after 15 s or on the next `online` event): no
  response, 408, 409, 429, 502, 503 or 504. On the subscribe and transfer routes, only the
  idempotency interceptor returns a 409:
  - "already in progress" and "state unavailable" resolve by resending;
  - "reused with a different payload" cannot occur on a replay, which resends the same key
    and body.

  The RFC 7807 filter replaces the message with a generic `detail`, so the status code is
  the only reliable signal. A key stuck in progress is bounded by the 23-hour window check
  below.
- **`conflict`**, invalid (cannot succeed, even after Retry): the bond is not `Active`, it
  has matured, a subscription exceeds the remaining supply, or a transfer exceeds the
  wallet's balance.
- **`conflict`**, stale (Retry sends it anyway): the wallet's holder balance differs from
  the basis captured at enqueue time, which may mean the operation already landed, or it
  was queued more than 23 hours ago (see below).
- **`failed`**: the API gave a definitive rejection (other 4xx). The API's message is shown.

**Retry** sets `rebase` and restarts the 23-hour clock. The next send accepts the bond's
state at that moment, but the invalid checks still apply. **Discard** removes the operation
and unblocks the ones behind it.

## Edge cases

- **Idempotency expiry.** The API keeps idempotency records for `IDEMPOTENCY_TTL_SECONDS`
  (24 h by default). Past that, a replay would execute as a new request, so operations older
  than 23 h (an hour of margin for clock skew) stop as stale and need Retry.
- **Another wallet.** Only operations queued by the connected wallet are sent, and only with
  a ready session. Another wallet's operations stay queued untouched, so they never go out
  with the wrong credentials.
- **Storage unavailable** (private mode, quota). The first refused write switches the
  service to in-memory state. The queue keeps working for that tab, but no longer survives
  a refresh or reaches other tabs.
- **`navigator.onLine` is only a hint.** `false` reliably means offline. `true` does not
  guarantee the API is reachable. An "online" send that gets no answer is treated as
  transient and retried, so a wrong `true` costs one failed request.
- **No Web Locks.** Web Locks are Baseline since March 2022 but exist only in secure
  contexts (HTTPS), so `navigator.locks` is `undefined` on plain-HTTP deployments. Without
  them, two tabs may send the same operation at once. The shared
  `Idempotency-Key` makes the second attempt a 409 "in progress" (transient) or a replay of
  the first result, never a second execution.
- **Two tabs enqueueing at the same instant.** `localStorage` has no cross-tab
  compare-and-set, so both tabs may take the same `seq`. Ordering stays deterministic
  because ties break on id, and both operations are kept.
- **Non-integer amounts** are never queued. They fail validation as before.

## Complexity

- Enqueue, patch and discard are each O(n) in queued operations: one parse and one
  serialise of the queue.
- A drain makes at most two requests per operation. It re-reads storage once per operation
  (O(n²) parse work), which is negligible at the queue sizes a user produces and is what
  keeps cross-tab sending safe.

## Compatibility

- No API or schema change.
- The bond page now sends subscribe and transfer with an `Idempotency-Key`. Both routes
  already accept the header, and requests without it behave exactly as before.

## Failure modes and recovery

| Symptom | Cause | Recovery |
|---|---|---|
| Operation stuck in "Saved, will send when the connection returns" | Offline, signed out, or another wallet connected | Reconnect, sign in, or switch back to the wallet that queued it |
| Operation shows a conflict right after reconnecting | The balance moved: another tab, device or out-of-band transfer, or the original attempt actually landed | Check the bond's holder balance or the transaction list. **Discard** if it already applied, **Retry** if not |
| Repeated transient retries | API or RPC degraded | Nothing to do. It retries every 15 s while online. Run `npm run monitor:journey` to see which dependency is failing |

**Rollback.** Revert the service and the bond-detail wiring. Leftover
`nbs_operation_queue` entries are inert without the service. To clear them in a support
session, run `localStorage.removeItem('nbs_operation_queue')`. Operations that were already
sent are tracked by `PendingTransactionsService` and are unaffected.
