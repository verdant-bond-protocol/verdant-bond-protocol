# Coupon Math: Property Tests and Invariants

This document describes the property-based test layer that checks the coupon arithmetic in `CouponEngine` and the contracts around it, the generators it uses, the invariants it asserts, and what running it found. The prose rules it encodes live in `coupon-accounting.md`; this file is the map from each rule to the test that enforces it.

## Framework

Library: `proptest` (Rust). Every contract crate that has arithmetic worth searching carries a `mod property` inside its `#[cfg(test)]` module, and the cross-contract cases live in `contracts/tests/src/lib.rs` under `integration::property`. The tests run under plain `cargo test`, which is the `Test` step of `.github/workflows/ci.yml`, so every pull request runs them.

| Crate | Module | Cases per property |
| --- | --- | --- |
| `coupon-engine` | `test::property` | 128 |
| `bond-issuer` | `test::property` | 64 |
| `oracle-consumer` | `test::property` | 128 |
| `dex-router` | `test::property` | 128 |
| `tests` (integration) | `integration::property` | 64 |

Reproducibility: proptest derives each run from a random seed and, on failure, writes the minimal failing input to `proptest-regressions/<file>.txt` next to the test source. Those files are committed, so a counterexample found once is replayed first on every later run. To widen a search locally, raise the case count without editing code:

```
PROPTEST_CASES=2000 cargo test -p nbbs-coupon-engine property
```

## Generators

Uniform ranges almost never land on the values where floor division and unit conversion misbehave, so the coupon-engine strategies mix hand-picked edges with a uniform tail and weight the edges three to one. They are defined at the top of `coupon-engine/src/lib.rs` `mod property`.

| Strategy | Edge values | Tail |
| --- | --- | --- |
| `carbon_strategy` | 0, 1, `CREDIT_DIVISOR - 1`, `CREDIT_DIVISOR`, `CREDIT_DIVISOR + 1`, `2 * CREDIT_DIVISOR - 1`, `7 * CREDIT_DIVISOR + 999`, 1e9 | 0 .. 1e8 |
| `balance_strategy` | 1, 2, 3, 7, 9, 11, 999, 1000, 9999 | 1 .. 10 000 |
| `balances_strategy` | one to five holders drawn from `balance_strategy` | |
| `unsubscribed_strategy` | 0 (weighted), 1, 9, 1000 tokens issued but never subscribed | |
| `credit_type_strategy` | `Carbon`, `BlueCarbon`, `Biodiversity`, `Basket` | |
| `biodiversity_strategy` | `Absent`; `Present((0,0,0))`; each component from 0, 1, 9, 10, 999, 1000 | |

The edges target specific mechanisms: `CREDIT_DIVISOR ± 1` hits the whole-credit truncation in `carbon_sequestered / CREDIT_DIVISOR`; small primes as balances make `credits_per_token * balance / FIXED_POINT` floor by different amounts per holder; unsubscribed supply checks that allocation divides by `total_subscribed` and not by `total_supply`; `Basket` exercises the path that floors twice per holder; `Present((0,0,0))` is a report that is valid for a biodiversity bond yet mints nothing.

## Invariants

Each invariant is stated once here and asserted in the named test. I0 to I6 are in `typed_distribution_invariants`, which runs every credit type against every biodiversity shape with the generators above.

| Id | Invariant | Test |
| --- | --- | --- |
| I0 | A report lacking the metrics the bond pays on is rejected with `InvalidReport`, and rejection leaves no period, no accrual and no dust behind | `typed_distribution_invariants` |
| I1 | Conservation: sum of holder accruals plus `UndistributedTotal` equals the pool exactly, and `CouponResult.total_credits` equals the distributed subtotal | `typed_distribution_invariants`, `distribution_conserves_credits`, `multi_period_conserves_credits`, `coupon_distribution_conserves_credits` (integration) |
| I2 | Dust bound: undistributed dust is at most `floors * (holders + 1)` minor units, where `floors` is 1 for single-type bonds and 2 for `Basket` | `typed_distribution_invariants` |
| I3 | No holder receives more than `pool * balance / total_subscribed`, and unsubscribed supply does not dilute subscribers | `typed_distribution_invariants`, `pro_rata_never_over_distributes` |
| I4 | Monotone and fair: a larger balance never earns less, equal balances earn the same | `typed_distribution_invariants` |
| I5 | Type routing: carbon-only bonds accrue no biodiversity credits, biodiversity-only bonds accrue no carbon, a basket's per-type accruals sum to the combined accrual | `typed_distribution_invariants` |
| I6 | A period closes exactly once; a second distribution of the same period fails | `typed_distribution_invariants` |
| I7 | Sub-credit sequestration truncates per report: `carbon < CREDIT_DIVISOR` mints nothing and the remainder is not carried forward | `whole_credit_truncation_is_per_report` |
| I8 | Biodiversity credits are additive in their three components across the range the engine can pay out | `biodiversity_credits_are_additive` |
| I9 | `preview_subscribe` never lies: the failure it predicts is exactly what `subscribe` returns, and a clean preview is always followed by a successful subscription | `preview_subscribe_agrees_with_subscribe` (bond-issuer) |
| I10 | Supply conservation: through arbitrary subscriptions and transfers, holder balances sum to `total_subscribed` and never exceed `total_supply` | `subscription_conserves_supply` (bond-issuer) |
| I11 | Claiming and retiring draw on one balance: after `retire_credits`, `accrued_credits` drops by exactly the retired amount and `claim_credits` returns only what is left | `test_coupon_accounting_invariants` (integration), `test_retire_debits_coupon_ledger_and_blocks_double_spend`, `test_consume_credits_debits_ledgers_oldest_first` |
| I12 | Sweeping returns exactly the accumulated dust and leaves accruals untouched | `test_coupon_accounting_invariants`, `distribution_conserves_credits` |
| I13 | Cross-contract slashing conserves stake and deactivates a provider exactly when its stake reaches zero | `cross_contract_slash_conserves_stake` (integration) |
| I14 | DEX settlement conserves value between bond tokens and quote asset | `dex_settlement_conserves_value` (integration) |

Mapping to `coupon-accounting.md`: its conservation rule is I1 plus I11 plus I12; lifecycle rule 1 (distribution) is I1 to I6; rule 2 (claiming) is I11; rule 3 (sweeping) is I12; rule 4 (maturity) is covered by the integration lifecycle tests instead of a property, since maturity does not change any arithmetic.

## What the search found

Running the invariants against the boundary generators, and reconciling them with the documented rules, surfaced the following. Each is either fixed in this change set or documented with the reason it stays.

1. Allocation divides by subscribed tokens, not by supply. The integration invariant test assumed a bond with 9 000 of 10 000 tokens subscribed would leave 10% of the pool undistributed. The contract (`checked_ratio(total_credits, FIXED_POINT, total_subscribed)`) gives subscribers the whole pool and leaves only rounding dust, which is what `coupon-engine`'s own unit tests already asserted. The integration test was also written in whole credits while the contract returns minor units. Fixed: the test now states the invariant against the pool in minor units, and I3 pins the subscribed-token semantics so the two can no longer drift apart.

2. Retiring and claiming spent the same balance twice. `coupon-accounting.md` rule 2 says a retirement reduces the holder's accrued balance in `CouponEngine`. The contracts did not do that: `retire_credits` kept its own ledger and `claim_credits` zeroed the engine's balance independently, so a holder could retire everything and then claim everything. Fixed: `CouponEngine.consume_credits` now settles the debit under the holder's authorization before the certificate is minted (I11).

3. Whole-credit truncation happens per report, before scaling. A report of 1 999 tonnes mints exactly one credit; the 999-tonne remainder is not carried to the next period, even though minor units could represent it. This matches how registries issue whole credits and is now pinned by I7 so a future change to the conversion is a deliberate one. Any change here is a product decision, not a bug fix.

4. `compute_biodiversity_credits` uses saturating arithmetic while every other path uses checked arithmetic. Traced: any input large enough to saturate produces a total above `i128::MAX / FIXED_POINT`, which the following `checked_ratio` rejects with `Overflow`, so no wrong payout can reach a holder. The mismatch is documented in I8's comment and left as is.

5. The oracle threshold defaulted to one signature, letting the admin alone verify the report a coupon is paid from. Found while reconciling `docs/oracle-design.md` (which said two) against `DEFAULT_SIGNATURE_THRESHOLD`; fixed by aligning the constant and the test helpers. Covered in `access-control-review.md` as F3.

6. (#189) Splitting one holding into many micro-accounts cannot capture extra dust. Every holder's accrual is `floor(credits_per_token * balance / FIXED_POINT)` computed independently (I3, I4). For any split of a balance `b` into `b1 + b2 + ... = b`, `floor(x*b1) + floor(x*b2) + ... <= floor(x*b)` always holds — floor is subadditive — so splitting can only produce *less or equal* aggregate credit than one holder claiming the same total balance, never more. This is not a new mechanism; it falls directly out of I3/I4 and the existing dust-conservation tests (I1, I2), so no code change was needed — it is recorded here because the issue asked for it to be checked and documented, not assumed.

   What is **not** covered by any invariant here, and remains an open risk: `distribute_coupon_batch` reads each holder's balance *live* via `bond_issuer.get_holder_balance` at the ledger the keeper happens to call it, not at a balance recorded at the period's start. A holder who acquires a large balance immediately before the keeper's batch call and disposes of it immediately after receives that period's full pro-rata share for a holding they only had for one ledger, at the expense of whoever held the tranche for the rest of the period. Closing this requires either `bond-issuer` exposing a historical/checkpointed balance query (e.g. balance as of a recorded `period_start_ledger`) or freezing transfers during a short accrual-snapshot window, and changing `distribute_coupon_batch` to read through that instead of current balance. That is a cross-contract storage/interface change to `bond-issuer` as well as `coupon-engine`, not a self-contained fix, and is not implemented in this change set.

## Adding a property

Put a new strategy next to the existing ones in the crate's `mod property`, prefer `proptest::sample::select` with an explicit edge list weighted against a uniform tail, and state the invariant as a comment above the `#[test]` in the same words as this table. Add the row here. If the property fails, keep the regression file proptest writes and fix the contract or the invariant, never the generator.
