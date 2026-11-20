# Cross-Currency Settlement Mechanism

## Overview
This specification details the cross-currency settlement pipeline between XLM-denominated bond purchase prices and carbon-credit-denominated (or fiat-stablecoin) coupon distributions within the Verdant Bond Protocol.

## Settlement Flow
1. **Primary Subscription**: Investors deposit `XLM` or `USDC` into the `primary-subscription-auction` contract.
2. **Oracle Rate Ingestion**: Soroban contracts pull real-time exchange rates via the `oracle-consumer` from verified price feeds (Stellar DEX / Band / Chainlink).
3. **Coupon Accrual & Conversion**:
   - Nature project yields produce carbon credits (e.g., `VERDANT-CREDIT`).
   - Project operators lock credits in `credit-retirement` or execute automated DEX swaps into `USDC`/`XLM` via `dex-router`.
   - Coupons are distributed in the investor's selected payout currency (`XLM`, `USDC`, or `VERDANT-CREDIT`).

## Conversion Invariants
- **Fixed-Point Precision**: All cross-currency conversions use 128-bit fixed-point arithmetic (`1e7` Stroop precision) with strict floor rounding in favor of the protocol reserve.
- **Slippage Bounding**: Automated DEX swaps during coupon distribution enforce a maximum 50 bps slippage limit. If market depth is insufficient, coupon payouts fall back to in-kind credit distribution.
