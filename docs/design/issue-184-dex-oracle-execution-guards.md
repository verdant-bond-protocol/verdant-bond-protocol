# DEX Router oracle execution guards (#184)

## Scope and price model

The DEX remains a fixed-price order book. A seller's ask is still the execution
price; the router does not create AMM reserves, compute a curve, or reprice an
order against a pool. For each `(bond_id, quote_asset)` market, the router now
requires an admin-configured TWAP reference and applies bounded execution
checks to both `execute_purchase` and `reveal_purchase` settlement.

The oracle anchor is a sanity bound, not a replacement for the ask. The buyer's
`max_price` remains a separate limit: it must cover the ask, and the actual ask
must also be within the configured basis-point deviation of the current TWAP.
Settlement always transfers at the listed ask.

## Oracle trust, update, and freshness

`configure_market` and `update_oracle_reference` are permissioned by the
router's current admin, require address authorization, and consume that
address's sequential router nonce. The updater supplies the TWAP price,
observation timestamp, and volume represented by the source sample. Prices
must be positive; the timestamp cannot be in the future or older than the
configured maximum age; and sample volume must be positive and meet the
configured minimum.

This is an explicit, admin-operated oracle input. The router does not verify a
publisher signature, query another contract, or independently calculate the
TWAP. The admin/updater and its upstream oracle process are trusted to attest
that the price and volume match the documented market and TWAP window. Admin
rotation should follow the deployment's normal key-management process. A
missing or stale reference fails closed for trading.

## Limits and circuit breaker

The per-market configuration and rolling oracle/volume/breaker state each use
one persistent key, with a bounded record size and no per-ledger history.
Active markets refresh their Soroban TTL on update and settlement. If an
inactive market's records expire, execution fails closed until the admin
reconfigures the market and submits a fresh reference.

The per-market configuration contains:

* minimum oracle sample volume;
* maximum ask-to-reference deviation in basis points (0–10,000);
* maximum aggregate quote proceeds per ledger;
* maximum oracle age; and
* divergence grace period in seconds.

The price check uses the absolute difference between the listed ask and the
current TWAP, bounded by `floor(TWAP * deviation_bps / 10,000)`. All
multiplication, subtraction, volume accumulation, and pause-deadline arithmetic
are checked. Per-ledger volume is a single rolling record per market; it is
reset logically when the ledger sequence changes, so storage does not grow
with the number of blocks.

When a new TWAP moves farther than the configured deviation from the previous
reference, the router stores a market pause deadline at `update_time + grace`.
The new reference is recorded, but purchases stay paused until that deadline.
Further divergent updates restart the grace period; stable updates do not
shorten it. Recovery is automatic when the deadline passes, provided the
reference remains fresh and the ask still satisfies the deviation check.
Neither settlement path can bypass this state.

## Zero-volume behavior

An oracle update with zero volume is rejected and does not replace the last
reference. A non-zero sample below the configured minimum is also rejected;
this makes a low-liquidity print insufficient to move the anchor. These volume
checks are only as reliable as the permissioned updater's source data.

Oracle sample volume and DEX trade volume are distinct. A fresh, sufficiently
liquid oracle sample can remain usable when the DEX itself has no fills. If no
DEX trade occurs in a ledger, its accumulated quote volume remains zero; the
next ledger starts a fresh budget. The router does not infer a price or
liquidity from order-book balances, deposits, or fabricated reserves.

## Verification coverage

Router tests cover low/zero-volume oracle samples, a wide-spread ask, per-ledger
quote-volume exhaustion and next-ledger reset, a divergent-reference pause and
recovery, and both immediate and commit/reveal paths while paused. Existing
purchase tests exercise successful fills using an explicitly installed TWAP.
