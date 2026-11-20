# Fixed-Point Coupon Arithmetic and Rounding Policy (#183)

## Canonical units

All carbon, blue-carbon, biodiversity, and basket coupon balances use six
decimal places: `1_000_000` minor units per whole credit. This is the canonical
on-chain representation in `CreditType::minor_units()` and
`CREDIT_MINOR_UNITS`. The exposed per-token ratio uses a separate
`FIXED_POINT` of `10_000_000`; that scale is not a credit denomination.
Holder allocations are calculated directly from the integer pool, holder
balance, and subscribed supply, avoiding a second division through the
displayed per-token ratio.

Credit type conversion rates convert biodiversity measurements into the same
six-decimal minor-unit balance before allocation. Biodiversity metrics must be
non-negative. Conversion multiplication and addition are checked; invalid
negative measurements fail as `InvalidReport` and values exceeding the
supported `i128` intermediate bound fail as `Overflow`. No saturating
arithmetic is used to silently mint a maximum-sized credit amount.

## Rounding and remainder destination

Every holder division rounds down once. For a basket, carbon and biodiversity
are allocated independently with the same integer ratio and then summed. No
holder is credited more than the floor of their exact proportional
entitlement.

The difference between the period's credit pool and all holder accruals is
recorded in `PeriodInfo.undistributed` and added to the bond's
`UndistributedTotal`. This per-bond dust pool is the explicit deterministic
remainder destination; it is independent of claim order and is swept only by
the authorized admin through `sweep_undistributed`. The conservation identity
is:

`sum(holder accruals) + period undistributed == period credit pool`

Dust is not reassigned to the last claimant or to whichever holder happens to
appear first in an iteration. The allocation input rejects duplicate holders,
and holder claims only debit their already-recorded balances. Reversing the
holder input order produces the same per-holder amount and dust.

For basket coupon periods, the tier-1 oracle staleness discount is applied to
the carbon and biodiversity legs independently before allocation. CarbonChain
true-up adjustments are applied to the carbon leg (including baskets), while
biodiversity-only bonds apply them to the biodiversity leg.

## Overflow bound

`BondIssuer::MAX_SUPPLY` bounds the total subscribed token quantity by
`10^18`. The contract enforces a maximum coupon pool of `10^18` minor units
(one trillion whole credits) per bond and period. The largest direct holder
allocation multiplication is bounded by:

`pool * balance <= 10^18 * 10^18 = 10^36`

The exposed per-token ratio is separately bounded by
`pool * FIXED_POINT <= 10^25`. Both bounds are strictly below `i128::MAX`
(approximately `1.7 * 10^38`). Every multiplication is checked; the contract
returns `Overflow` if an oracle-derived or true-up-adjusted pool exceeds the
supported bound. Arbitrary `i128` report values are not assumed safe.

## Verification

`contracts/coupon-engine/src/lib.rs` property coverage verifies conservation of
holder accruals plus the dust pool over randomized periods and balances. The
max-supply boundary tests distribute a `10^18`-minor-unit pool across holders
whose balances sum exactly to `MAX_SUPPLY`, check allocation order
independence, and verify that a sole full-supply holder receives the exact pool
near the bound. See `coupon-math-invariants.md` and
`credit-distribution-invariants.md` for the related property-test inventory.
