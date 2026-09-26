# Credit-Distribution Invariants (audit input, issue #214)

Financially critical math in `contracts/coupon-engine` (fixed-point pro-rata
distribution across credit types with floor rounding). This document is the
auditor-facing invariant list; each invariant is enforced by property-based
tests (`proptest`, randomized tranche / credit-type / rounding combinations)
that run in CI via `cargo test` (see `.github/workflows/ci.yml`, `contracts` job).

## Invariants

- **INV-1 — No over-distribution.** `sum(holder accruals) <= total_credits`
  where `total_credits = carbon_total + biodiversity_total` derived from the
  verified oracle report. Floor division may leave dust, never a deficit.
- **INV-2 — Per-tranche cap.** No holder receives more than its contractual
  maximum: `holder_credits <= total_credits * balance / total_subscribed`
  (integer-division upper bound, per credit-type leg for `Basket`).
- **INV-3 — Conservation.** `distributed + undistributed == total_credits`
  per period, and across periods
  `sum(accrued) + undistributed_total == sum(total_credits)`.
  Verified on-chain via `PeriodInfo.undistributed` and
  `UndistributedTotal(bond_id)`, and off-chain in
  `docs/coupon-accounting.md`.
- **INV-4 — Type-ledger consistency.** `accrued == accrued_by_type(Carbon) +
  accrued_by_type(Biodiversity)` per holder; `Carbon`/`BlueCarbon` bonds only
  ever accrue the Carbon leg, `Biodiversity` only the Biodiversity leg,
  `Basket` accrues both legs that are `> 0`.
- **INV-5 — Non-negativity / dust.** All accruals and remainders are `>= 0`;
  `sweep_undistributed` returns exactly the remainder and zeroes the pool.

## Fuzz coverage (`coupon-engine::test::property`)

| Test | What varies | Invariants |
|---|---|---|
| `pro_rata_never_over_distributes` | total credits, 1–20 balances | INV-1, INV-5 |
| `distribution_conserves_credits` | sequestration, 1–5 balances (on-chain) | INV-1, INV-3, INV-5 |
| `multi_period_conserves_credits` | 2 periods × sequestration, 1–4 balances (on-chain) | INV-3 |
| `credit_type_never_over_distributes` (#214) | credit type (Carbon/BlueCarbon/Biodiversity/Basket), carbon, habitat/species/units, 1–5 balances (on-chain) | INV-1 – INV-4 |

Run: `cargo test -p nbbs-coupon-engine` (or workspace `cargo test` in CI).
Regression seeds: `contracts/coupon-engine/proptest-regressions/lib.txt`.

## Auditor notes

- All amounts are minor units (`CREDIT_MINOR_UNITS = 1_000_000`, 6 decimals,
  shared by every `CreditType` — see `contracts/shared/src/types.rs`).
- Rounding is always floor (`checked_ratio` = `value * mult / div`); dust
  accumulates in `undistributed`, recoverable via `sweep_undistributed`
  without touching holder accruals.
- Reports must be `Verified` and project-bound; unverified / foreign-project
  reports are rejected before any math runs.
