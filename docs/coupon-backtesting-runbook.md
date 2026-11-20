# Coupon Math Historical Performance Backtesting Runbook

This document details the historical performance backtesting tooling, evaluation process, and release checklist for modifying the coupon calculation formula in the Verdant Bond Protocol (resolving Issue #333).

---

## 1. Overview & Purpose

Any modification to the coupon formula (e.g. changing bounds, introducing true-up adjustments, or altering performance scaling) carries severe financial risk.

The **Coupon Backtesting Tooling** (`CouponBacktestService`) executes contract-faithful simulations of Soroban coupon logic against multi-year historical or synthetic performance datasets prior to contract upgrades or formula changes.

---

## 2. Mandatory Release Process Checklist

Before deploying any update to the coupon engine contract or formula:

- [ ] **Step 1: Import or Generate Multi-Year Dataset**:
  Ensure the dataset covers at least **5 years (20 quarterly reporting periods)** including edge-case scenarios (extreme spikes $> 100\%$, catastrophic drops $> 90\%$, zero token supply, and missing verifier attestations).
- [ ] **Step 2: Run Comparative Backtest**:
  Execute `POST /api/v1/bonds/backtest` with `formulaVersion: "COMPARE"`.
- [ ] **Step 3: Audit Variance Report**:
  Review the `BacktestReport` output:
  - Confirm total payouts under Formula V2 vs Formula V1.
  - Verify that the $+100\%$ cap prevented unintended overpayments during artificial spikes (`v2CapPreventedOverpayment`).
  - Verify that drops $> 90\%$ triggered `PERFORMANCE_DROP_FLAGGED` without division-by-zero or negative payouts.
- [ ] **Step 4: Governance Sign-off**:
  Submit the generated `BacktestReport` JSON to the Protocol Risk Committee before executing contract upgrades.

---

## 3. Backtest API Endpoint

### `POST /api/v1/bonds/backtest`
Evaluates multi-year performance datasets against Soroban contract logic.

**Request Payload**:
```json
{
  "syntheticYears": 5,
  "formulaVersion": "COMPARE"
}
```

**Response Output**:
- `totalPeriodsEvaluated`: Number of quarterly/monthly periods evaluated.
- `edgeCasesSummary`: Count of spikes flagged, drops flagged, zero supply risks, and attestation deficits.
- `comparison`: Total distributed under V1 vs V2, variance percentage, and overpayment prevented by bounds.
