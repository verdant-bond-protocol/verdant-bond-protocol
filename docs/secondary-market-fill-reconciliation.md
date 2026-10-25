# Secondary-market fill reconciliation

The DEX router is the source of truth for an order's remaining quantity. A
fill is one Soroban transaction: it validates the current `Order`, updates the
escrow and remaining amount, and only then invokes the bond issuer. A failed
issuer call reverts the complete transaction, so a cancelled order can never
release escrow while a fill still spends it.

## Partial fills and cancellation

`execute_purchase` accepts an amount no larger than the current order amount.
It writes `PartiallyFilled` with the exact remainder, or `Filled` when the
remainder reaches zero. `cancel_listing` reads that same current record and
releases only the remainder. Both operations are authenticated and consume a
seller/buyer nonce; Soroban transaction atomicity provides the deterministic
ordering when cancellation and fill are submitted concurrently. The first
transaction committed wins and the second observes `Filled`, `Cancelled`, or
the new partial remainder.

## Client reconciliation contract

Clients should treat `get_order(order_id)` as authoritative after every
transaction. In addition to the existing `order_filled` and
`order_cancelled` events, the router emits:

| Event | Payload | Use |
|---|---|---|
| `order_remaining` | `(order_id, remaining, status)` | Replace cached quantity after a fill |
| `order_cancelled_remaining` | `(order_id, remaining)` | Record the released remainder |

The events are emitted after the persistent order write. An indexer that sees
an event before its transaction is finalized must re-read the order and ignore
any locally calculated remainder that disagrees with the ledger.

## Required checks

- Reconcile partial fills from the order record, never from a requested amount.
- Treat `Filled` and `Cancelled` as terminal; retries must not issue transfers.
- On a failed transaction, keep the prior local state and retry with a fresh
  nonce after re-reading the order.
- Alert when an event payload and `get_order` disagree after finality; this is
  an indexer lag or data-integrity incident, not a client-side merge case.
