# Coupon Accounting Invariants

The Verdant Bond Protocol enforces strict conservation of carbon credits across the coupon lifecycle. Credits are derived from verified oracle reports and are distributed to bond holders. The accounting guarantees that no credits are magically created, lost in transit, or claimed multiple times.

## Conservation Rule

At any point in the lifecycle, the following equation must hold exactly:

`Total Sequestered = Total Claimed + Total Accrued (Unclaimed) + Undistributed + Total Swept`

Where:
- **Total Sequestered**: The total `carbon_sequestered` amount from all verified oracle reports that have been processed for a bond.
- **Total Claimed**: The sum of all credits successfully claimed and retired by bondholders via the `CreditRetirement` contract.
- **Total Accrued**: The sum of all credits allocated to bondholder balances in the `CouponEngine` but not yet claimed.
- **Undistributed**: The pool of credits in the `CouponEngine` that have not yet been distributed (either from a newly processed report, or left over due to fractional rounding / unallocated supply).
- **Total Swept**: Leftover dust and undistributed credits that the admin has recovered via `sweep_undistributed`.

## Lifecycle Invariants

1. **Distribution**: When `distribute_coupon` runs, it pulls from `Undistributed` and adds to each holder's `Accrued` balance proportional to their bond holdings. The sum of all additions plus any remainder (due to rounding) precisely equals the amount deducted from `Undistributed`.
2. **Claiming**: When a holder claims credits via `retire_credits`, their `Accrued` balance in the `CouponEngine` is reduced by exactly the claimed amount (`CreditRetirement` invokes `CouponEngine.consume_credits` under the holder's authorization before it mints the certificate), and the `CreditRetirement` contract records the retirement. A holder can never claim more than their accrued balance, and credits retired this way are no longer claimable through `claim_credits`. Duplicate claims fail deterministically.
3. **Sweeping**: `sweep_undistributed` allows the admin to recover any `Undistributed` credits. Once swept, these credits are removed from the `Undistributed` pool. Sweeping does not affect already `Accrued` balances; holders can still claim what they are owed. Post-sweep claims function normally for accrued balances.
4. **Maturity**: After bond maturity, the fundamental conservation rule still holds. Late claims are permitted against previously accrued balances.

These rules are verified on-chain and through cross-contract integration tests ensuring no edge case (such as zero-balance holders, partial distributions, or precision loss) can break the accounting. The executable form of each rule, and the generators used to search for counterexamples, are described in coupon-math-invariants.md.

## Senior-first waterfall (Issue #182)

`CouponEngine.settle_waterfall` is an additive settlement path for aggregate
tranche obligations. Each entry identifies a distinct `tranche_bond_id` and
must be ordered by strictly ascending `priority`; priority `0` is senior.
Carbon and biodiversity obligations are funded independently, and each asset
is paid senior-first without substitution. The caller supplies the due amounts
for the coupon period, including any partial-period accrual determined from
verified project performance, as well as the available amounts for settlement.

Any unpaid amount is persisted per bond and merged into the next settlement
before newly supplied obligations. Matching priority entries merge only when
they refer to the same tranche bond. The bounded state stores one aggregate
entry per priority, never one entry per investor, and retains each settlement
under a monotonically increasing settlement index.

`claim_waterfall` is the pull-based holder path. It reads the holder balance
`BondIssuer` checkpoints holder balances and subscribed supply whenever they
change. Settlement records each tranche's current checkpoint version.
`claim_waterfall` uses that immutable version, so a transfer, subscription, or
redemption after settlement cannot redirect the period's allocation. It
records a one-time claim for that holder, priority, and settlement. The
resulting carbon and biodiversity amounts enter the normal `CouponEngine`
accrued balance. They can then be claimed through `claim_credits` or consumed
by the existing retirement flow. No transaction iterates over investors;
checkpoint lookup is logarithmic in that account's balance-change history.
`waterfall_claimable` returns a quote for the latest settlement;
`waterfall_claimable_for_holder` is a quote helper for adapters with an
existing balance snapshot and is not the settlement path.

The coupon contract accounts for credits but does not custody external credit
tokens. The authorized settlement caller must ensure the supplied available
balances are actually backed by the deployment's credit escrow or retirement
source. Partial-period performance accrual is likewise calculated from
verified reports by the caller before providing each period's due amounts.
