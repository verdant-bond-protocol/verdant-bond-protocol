# Design Note: Payout Reconciliation Against Ledger & On-Chain Events (#621)

## Scope of This Vertical Slice

This slice delivers a read-only, resumable, idempotent three-way payout reconciliation job in the `reconciliation` module:

- **Includes**:
  - Three-way comparison for a `(bondId, periodId)` payout period:
    1. **Payout Schedule** (what should be paid)
    2. **Internal Ledger** (what was recorded internally)
    3. **On-Chain Stellar Events** (what actually settled on-chain, verified for `successful === true`, `assetCode`, `assetIssuer`, `destination`, and exact `amountMinorUnits` in `BigInt`).
  - Discrepancy classification: `matched`, `pending_settlement` (within settling window), `missing_on_chain`, `missing_in_ledger`, `amount_mismatch`, `wrong_destination_or_asset`, `duplicate`, `unexpected_extra_payment`.
  - Resumable, bounded, retry-with-backoff paged chain fetcher (`OnChainPayoutClient`) that parks incomplete runs as `partial` and never marks missing-data runs as `matched`.
  - Read-only invariant: never moves funds or mutates history; corrections are recorded as separate audited `PayoutAdjustmentRecord` entries.
  - Executable accounting invariant check: `totalPaid == totalScheduled - recordedExceptionsDelta`.
  - RBAC permission `RECONCILE_PAYOUTS` (granted only to `SETTLEMENT_MANAGER` and `MAINTAINER`).
- **Deliberately Left Out**:
  - Live Horizon/Soroban RPC network polling in tests (uses `OnChainPayoutClient` interface with `InMemoryOnChainPayoutClient` for deterministic offline tests).
  - Automated remediation / clawback transactions (all corrections require manual authorized adjustment records).

## Settling Window

Recent scheduled payouts where `now - scheduledAt < settlingWindowMs` (default `60_000` ms, configurable via `PAYOUT_SETTLING_WINDOW_MS`) are classified as `pending_settlement` rather than `missing_on_chain` to tolerate Stellar ledger close delays.

## Discrepancy Recovery Runbook

| Discrepancy Type | Recovery Action |
| --- | --- |
| `missing_on_chain` | Verify Horizon/RPC health and nonce queue; if unsubmitted, re-trigger payout with original idempotency key, or record an authorized adjustment. |
| `missing_in_ledger` | Append the missing `settlement.completed` / `coupon.distributed` event to the internal ledger via an authorized backfill/adjustment record referencing the `txHash`. |
| `amount_mismatch` | Compute exact delta in minor units; issue a top-up payout (if underpaid) or record a clawback/credit adjustment (if overpaid) with audit reason. |
| `wrong_destination_or_asset` | Flag for finance/compliance review; record an adjustment and execute a corrective transfer to the scheduled destination/asset. |
| `duplicate` | Record a `duplicate_payment` adjustment referencing both `txHash`es and initiate recovery from recipient or offset future coupons. |
| `unexpected_extra_payment` | Investigate unscheduled payment `txHash`; record an `unexpected_extra_payment` adjustment and reconcile against treasury. |
