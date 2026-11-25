# Default Waterfall Property Tests Across Partial Losses (#616)

## Overview
`contracts/tests/src/default_waterfall_property_test.rs` uses `proptest` to verify financial invariants of the multi-tranche default waterfall across arbitrary partial losses and post-default recoveries.

## Verified Invariants
1. **Conservation**: `total_paid + total_loss == total_notional` for every partial loss `0 <= loss <= total_notional`.
2. **Reverse-Seniority Loss Absorption**: Junior tranches absorb losses completely before mezzanine, and mezzanine before senior.
3. **Strict Seniority Payout**: No junior tranche receives payment while any senior tranche has unpaid notional.
4. **Monotonicity**: Increasing partial loss never increases any tranche's payout or decreases its absorbed loss.
5. **Senior-First Recovery**: Post-default recovery inflows restore tranches in strict senior-first order without exceeding original notional.

## Edge Cases, Authorization & Retry
- **Unauthorized callers**: Rejected with `WaterfallError::Unauthorized`.
- **Invalid inputs**: Empty tranche sets, zero-notional tranches, duplicate tranche IDs, losses exceeding total notional, and over-recovery are rejected cleanly.
- **Idempotent retry**: `retry_settlement` with a matching `idempotency_key` returns the prior settlement without double-applying losses.
