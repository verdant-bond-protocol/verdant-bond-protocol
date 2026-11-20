# Bond Liability vs. Available Reserve Funding Alerting Specification

## Executive Summary

The Verdant Bond Protocol requires deterministic, automated alerting whenever outstanding bond liabilities (aggregate of principal redemption obligations, accrued/undistributed coupon claims, and penalty liabilities) exceed available reserve funding (redemption escrow pools, liquidity buffers, and protocol insurance reserves).

This document specifies the architecture, execution paths, operational edge cases, failure modes, recovery/rollback workflows, and financial invariants implemented across both the Soroban smart contract layer (`contracts/shared/src/liability_reserve_alert.rs`) and the off-chain API service layer (`api/src/bonds/liability-reserve-alert.service.ts`).

---

## Architecture Overview

The system operates across a dual-layer architecture:

1. **Soroban On-Chain Module (`contracts/shared/src/liability_reserve_alert.rs`)**:
   - Maintains authoritative `LiabilityReserveAlert` records in contract storage.
   - Emits `reserve_shortfall_alert` Soroban contract events with bond identifier, shortfall amount, and coverage basis points.
   - Enforces cryptographic signer authentication (`admin.require_auth()`) for acknowledgment and manual resolution.
2. **API Service Layer (`api/src/bonds/liability-reserve-alert.service.ts`)**:
   - Computes liability breakdowns (principal, coupon, penalty) and available reserve breakdowns (escrow, liquidity buffer, insurance).
   - Dispatches high-priority notifications via `NotificationsService` categorized under the mandatory `settlement_failure` channel (bypassing optional user opt-outs).
   - Manages state cache persistence with Redis and in-memory fallbacks.

---

## Core Execution Paths

### 1. Normal Path

- **Deficit Detection**: When evaluated liabilities exceed available reserves:
  $$\text{Shortfall} = \text{Total Liabilities} - \text{Available Reserves} > 0$$
  $$\text{Coverage BPS} = \left\lfloor \frac{\text{Available Reserves} \times 10000}{\text{Total Liabilities}} \right\rfloor$$
- **Severity Classification**:
  - $\text{Coverage BPS} \le 5000$ (reserves cover $\le 50\%$): `EMERGENCY_INSOLVENCY`
  - $5000 < \text{Coverage BPS} \le \text{CriticalThreshold}$ (default $8000$ bps / $80\%$): `CRITICAL_DEFICIT`
  - $\text{CriticalThreshold} < \text{Coverage BPS} < 10000$: `WARNING`
- **Auto-Resolution**: When a subsequent evaluation observes $\text{Available Reserves} \ge \text{Total Liabilities}$ (or liabilities are reduced to zero):
  - Any active alert for the bond is transitioned to `RESOLVED` status with `ADEQUATE` severity.
  - `shortfall` is set to `0`, `coverageBps` to `10000`, and `resolvedAt` timestamp is set.
  - Active tracking indices for the bond are cleared.

### 2. Failure Path

- **Non-Negative Value Enforcement**:
  - Liabilities or reserves $< 0$ reject immediately with `AlertError::NegativeValue` (contract) or `BadRequestException` (API).
- **Threshold Validity**:
  - Thresholds must satisfy $10000 \ge \text{warningThreshold} \ge \text{criticalThreshold} \ge \text{emergencyThreshold} \ge 0$. Violations reject with `AlertError::InvalidThreshold` / `BadRequestException`.
- **Underfunded Resolution Rejection**:
  - Manual resolution attempts providing a `replenishedAmount < shortfall` fail with `AlertError::InsufficientReplenishment` / `BadRequestException`.
- **State Transition Guards**:
  - Acknowledging an already acknowledged alert fails with `AlertError::AlreadyAcknowledged`.
  - Acknowledging or resolving an already resolved alert fails with `AlertError::AlreadyResolved`.
  - Lookup of non-existent alert records fails with `AlertError::AlertNotFound` / `NotFoundException`.

### 3. Retry Path

- **Idempotency Under Same Severity**:
  - If a subsequent scan or worker evaluation evaluates an existing deficit under the same severity tier, the service updates the existing alert record, increments `retryCount`, refreshes financial amounts, and records a `RETRIED` audit entry without creating duplicate alert IDs.
  - High-frequency notifications are suppressed/deduplicated via deterministic event IDs (`liability-alert-${bondId}-${alertId}-retry-${retryCount}`).
- **Severity Escalation**:
  - If a deficit worsens across severity tiers (e.g. `WARNING` $\to$ `CRITICAL_DEFICIT`), the prior alert is superseded and marked `RESOLVED` (`ESCALATED` audit action), and a new alert is generated with elevated urgency.

### 4. Authorization Path

- **Alert Acknowledgment**:
  - Requires authorized roles (`admin`, `risk_officer`, `settlement_admin`, `operator`).
  - Sets `acknowledgedBy`, `acknowledgedAt`, and updates status to `ACKNOWLEDGED`.
- **Manual Resolution via Capital Replenishment**:
  - Requires elevated roles (`admin`, `settlement_admin`).
  - Verifies and applies reserve replenishment capital $\ge \text{shortfall}$.
  - Marks status as `RESOLVED`, sets `resolvedAt`, and clears bond active alert state.

---

## Operational Edge Cases & Failure Modes

| Edge Case / Failure Mode | Root Cause | System Response & Mitigation |
| :--- | :--- | :--- |
| **Partial Replenishment** | Treasury deposits capital insufficient to eliminate the entire shortfall. | Resolution call rejected with `InsufficientReplenishment`. Alert remains `ACTIVE` or `ACKNOWLEDGED` with shortfall decremented upon next periodic evaluation. |
| **Rapid Market Liability Spike** | Large coupon accrual or penalty assessment deepens deficit within a block. | Alert severity dynamically escalates to `CRITICAL_DEFICIT` or `EMERGENCY_INSOLVENCY`, triggering emergency notification broadcasts. |
| **Redis Connectivity Interruption** | Network partition or Redis restart during active monitoring. | Service automatically falls back to in-memory state; subsequent reconciliation restores Redis keys once reconnected. |
| **Notification Engine Throttling** | Multiple retries within short time window could flood administrator inboxes. | Notifications use deterministic `eventId` deduplication, ensuring mandatory delivery without notification spam. |
| **Zero Liabilities State** | Bond has zero subscriptions or has concluded all obligations. | Evaluator treats 0 liabilities as fully adequate (coverage 10000 bps) and auto-resolves any residual alerts. |

---

## Recovery and Rollback Procedures

### Emergency Reserve Replenishment Runbook

1. **Detection**: Administrator receives high-priority `settlement_failure` notification detailing bond ID, shortfall, and current coverage BPS.
2. **Triage**: Inspect active alert details using `LiabilityReserveAlertService::getActiveAlert(bondId)` or on-chain `get_active_alert(bondId)`.
3. **Escrow Injection**:
   - Transfer required capital from reserve vault or secondary liquidity pool into the bond's redemption escrow.
4. **Resolution Verification**:
   - Trigger `evaluateFunding(bondId, liabilities, newReserves)`.
   - Confirm alert transitions to `RESOLVED` with `coverageBps = 10000` and `shortfall = 0`.

### Rollback & Invariant Remediation

- If an administrative acknowledgment was executed in error (e.g., misidentified bond ID), the alert remains in `ACKNOWLEDGED` status (not resolved) and continues tracking the deficit. It cannot be resolved until full reserve replenishment is verified.
- In the event of system restart or cache eviction, state is safely reconstructed idempotently from ledger records without alert duplication.

---

## Financial Invariants

1. **Conservation of Shortfall**:
   $$\text{Shortfall} = \max(0, \text{Liabilities} - \text{Reserves})$$
   Shortfall is strictly zero if and only if $\text{Reserves} \ge \text{Liabilities}$.
2. **Bounded Coverage Metric**:
   $$0 \le \text{CoverageBps} \le 10000$$
   Coverage ratio in basis points is guaranteed to remain bounded within $[0, 10000]$.
3. **Monotonicity**:
   $$\frac{\partial \text{Shortfall}}{\partial \text{Reserves}} \le 0 \quad \text{for fixed Liabilities}$$
   Incremental reserve funding never increases the shortfall.
4. **No Silent Deficit**:
   $$\forall \text{bond } b, \; \text{Liabilities}(b) > \text{Reserves}(b) \implies \exists \text{ active alert for } b$$
   Underfunded states cannot exist without triggering or updating an active alert.
