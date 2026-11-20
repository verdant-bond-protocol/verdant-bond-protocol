# Runbook: Marketplace Quote Balance & Order Reconciliation

The API reconciles its indexed/cached view of marketplace state against the
authoritative on-chain DEX router ledger on a schedule (every 10 minutes by
default, configurable via `DEX_RECON_CRON`). This runbook explains how to
investigate a mismatch alert and repair stale cache/index records.

See `api/src/marketplace/dex.reconciliation.service.ts` for the implementation
and `api/src/marketplace/dex.reconciliation.service.spec.ts` for the covered
scenarios (stale cache, changed balance, missing order, escrow invariant).

## What is reconciled

| Check | Indexed/API source | On-chain source | Mismatch type |
| --- | --- | --- | --- |
| Quote balance | `quote:balance:<addr>:<asset>` cache (seeded/maintained by deposits & withdrawals) | `DEXRouter.get_quote_balance()` | `balance_mismatch` |
| Open order status | `order:<id>` + `orders:*` caches | `DEXRouter.get_order()` status | `stale_order_cache` |
| Order presence | API order index (open orders) | on-chain order id scan | `missing_order` |
| Seller escrow | — | `get_quote_balance(seller)` vs `pricePerToken * amount` | `order_escrow_invariant` |

## Where alerts land

- Every run is logged with a `correlationId` via `DexReconciliationService`.
- On a mismatch the service logs `WARN [<correlationId>] Marketplace reconciliation found N mismatch(es): ...`.
- The full report is persisted to Redis under `dex:recon:last` (7-day TTL).
- The last 200 mismatches are kept under `dex:recon:mismatches`.

## Investigation steps

1. Pull the latest report:
   `GET /marketplace/reconciliation/mismatches` (operator wallet-header) or read
   `dex:recon:last` directly from Redis.
2. Group mismatches by `type` and `correlationId`. A burst of the same type with
   one correlation id is a single reconcile run — investigate the root cause once.
3. For `balance_mismatch`: compare `observed` (the stale API index) vs `expected`
   (the true on-chain balance). A positive `expected` usually means a deposit or
   purchase was not reflected because cache invalidation did not run (a failed
   cache invalidation). A negative `expected` can indicate an unexpected on-chain
   movement (e.g. an off-platform withdrawal).
4. For `stale_order_cache`: the order's cached status disagrees with the ledger.
   Most often the order was filled/cancelled on-chain but the `order:<id>` cache
   had not expired (60s TTL) or an `orders:*` listing was served stale.
5. For `missing_order`: an open order exists on-chain but is absent from the API
   index. This points at a gap in `listOrders` indexing, not a cache value.
6. For `order_escrow_invariant`: the seller's on-chain balance no longer covers
   the order notional. This is a data-integrity risk (a buy could fail or be
   partially filled) and should be escalated to the seller/outreach.

## Repair steps

The safe, default repair is to evict the affected caches so the next read
re-fetches from the ledger. This is exactly what `repair()` does:

- `balance_mismatch` → re-syncs `quote:balance:<addr>:<asset>` to the on-chain
  value and deletes the stale key.
- `stale_order_cache` / `missing_order` / `order_escrow_invariant` → `DEL
  order:<id>` and `DEL orders:*` (force a fresh re-index on next `listOrders`).

Trigger repair:

```
POST /marketplace/reconciliation/repair      # repairs the last stored report
# or send an explicit report body:
POST /marketplace/reconciliation/repair
{ "report": { "correlationId": "...", "mismatches": [ ... ] } }
```

The response lists the invalidated keys/actions taken (`repaired`, `actions`).

### Manual Redis repair (if the service is down)

```
# balance
DEL quote:balance:<addr>:<asset>
# orders
DEL order:<id>
SCAN 0 MATCH orders:* COUNT 100   # then DEL each page
```

After eviction, confirm the next `GET /marketplace/orders/:id` and
`GET /marketplace/quote-balance` return values matching the ledger.

## Tuning

- `DEX_RECON_CRON` — cron expression for the scheduled run (default every 10m).
- `DEX_RECON_WALLETS` — comma-separated wallets to always sample (in addition to
  every open-order seller).
- `DEX_RECON_MAX_ORDER_SCAN` — cap on the on-chain order-id walk used for
  missing-order detection (default 500).

## False positives

A `balance_mismatch` on the very first run for a wallet is expected (the index is
being seeded) and is reported as clean, not as a mismatch. Only a *subsequent*
divergence is flagged. If you see persistent mismatches after a repair, the
deposit/withdraw cache-invalidation path (in `dex.service.ts`) should be audited.
