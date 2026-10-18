# Bond Default & Insolvency Waterfall Specification

## Overview
This document defines the strict, deterministic default and insolvency waterfall execution sequence in the event of catastrophic nature project failure (e.g., wildfire, deforestation, drought, or operator insolvency).

## Priority Waterfall
When a nature-backed bond enters `Default` status (triggered after 30 days of delinquent coupon payment or a Tier 3 operator slashing event), liquidation proceeds are distributed in the following strict priority:

1. **Senior Investor Principal Recovery**:
   - 100% of escrowed reserves in `contracts/bond-issuer` are distributed pro-rata to Senior Tranche bondholders until 100% of face value principal is restored.
2. **Subordinated Tranche Principal Recovery**:
   - Remaining escrowed funds and slashed operator stake (`VERDANT-STAKE`) are allocated to Junior/Mezzanine Tranche holders.
3. **Accrued & Unpaid Coupon Settlement**:
   - Any residual liquid capital settles outstanding accrued interest.
4. **Insurance & Parametric Buffer Invalidation**:
   - Parametric weather insurance policies locked in `credit-registry` pay out directly to the recovery pool.

## Invariant Guarantees
- **No Protocol Extraction**: Protocol fees are completely waived during waterfall liquidation.
- **Deterministic Ordering**: Execution is fully automated on-chain via `contracts/bond-issuer::liquidate_defaulted_bond` with no administrative discretion or manual intervention.
