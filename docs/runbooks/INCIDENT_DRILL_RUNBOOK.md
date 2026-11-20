# Verdant Bond Protocol - Executable Incident Drill Runbook

Resolves **Issue #356**.

## 1. Overview and Objectives
This runbook defines the operational procedures for quarterly and pre-release incident drills across the core Verdant Bond Protocol lifecycle:
1. **Green Bond Issuance Failure & Rollback**
2. **Carbon Credit Coupon Distribution Halt & Multi-Oracle Recovery**
3. **Secondary-Market Settlement Deadlock & Escrow Reversal**

Every procedure in this runbook is backed by automated executable verification checks implemented in:
- Service: `api/src/recovery/incident-drill.service.ts`
- Automated CLI Runner: `api/scripts/incident-drill.ts` (`npm run incident:drill`)
- Comprehensive Test Suite: `api/src/recovery/incident-drill.service.spec.ts`

---

## 2. Executable Verification Commands

Maintainers, SREs, and CI pipelines can execute automated drills on demand:

```bash
# Run all incident drills end-to-end
npm run incident:drill

# Run drill with JSON structured output for automated metric ingestion
npm run incident:drill -- --json

# Run individual target drills
npm run incident:drill -- --drill=issuance
npm run incident:drill -- --drill=coupon
npm run incident:drill -- --drill=settlement
```

---

## 3. Drill Scenarios & Automated Verification Checks

### Scenario 1: Green Bond Issuance Failure & Rollback
- **Trigger Scenario:** A green bond in `ISSUED` state experiences an issuance failure (e.g. invalid ESG tranche covenant, corrupted metadata CID, or auction fails to meet required minimum funding threshold).
- **Automated Verification Steps:**
  1. **Fault Injection:** Injects uncommitted bond record in failed auction status.
  2. **Emergency Rollback:** Invokes `bondStateMachine.transition(state, BondEvent.CANCEL)`, moving state to terminal `CANCELLED`.
  3. **Data Invariants Validation:** `RollbackVerificationService` verifies that:
     - No orphaned subscription orders remain in memory or Redis.
     - All investor escrowed deposits are credited back to wallet balances.
     - Zero uncontained collateral tokens remain locked.
  4. **User Impact Reporting:**
     - Computes impacted investor count, financial exposure ($USD), and SLA status.
     - Generates automated customer communication:
       *"Bond issuance #999 was safely cancelled before settlement. All reserved investor capital returned to wallet balances."*

---

### Scenario 2: Carbon Credit Coupon Distribution Halt & Oracle Recovery
- **Trigger Scenario:** Satellite or IoT sensor data drift exceeds tolerance thresholds, tripping the oracle circuit breaker and halting coupon distribution mid-flight.
- **Automated Verification Steps:**
  1. **Fault Injection:** Transitions active coupon cycle to `CHALLENGED` state.
  2. **Multi-Source Reconciliation Recovery:**
     - Invokes secondary oracle consensus aggregator (`blue-carbon` & `verra` multi-feed adapter).
     - Resolves dispute via `RESOLVE_CHALLENGE`, advancing coupon to `RECONCILED`.
     - Resumes distribution via `START_DISTRIBUTION` -> `DISTRIBUTING` -> `DISTRIBUTED`.
  3. **Accounting Invariants Validation:**
     - Verifies balance conservation: total carbon credit units minted equal verified metric tons of sequestered carbon ($\Delta \text{credits} = \Delta \text{tCO}_2\text{e}$).
  4. **User Impact Reporting:**
     - Confirms zero lost credits, estimates delay duration (e.g. 12 minutes), and verifies that SLA breach risk was avoided.

---

### Scenario 3: Secondary-Market Settlement Deadlock & Escrow Reversal
- **Trigger Scenario:** Partial settlement deadlock where tokenized bond units are escrowed by seller, but buyer counter-currency settlement times out or fails on the Stellar ledger.
- **Automated Verification Steps:**
  1. **Fault Injection:** Simulates locked order in `DISPUTED` settlement state.
  2. **Atomic Escrow Rollback:**
     - Invokes `SettlementEvent.RESOLVE_ROLLBACK`, transitioning settlement to terminal `REVERSED`.
     - Atomically releases escrow: returns bond units to seller and unlocks buyer stablecoins.
  3. **Zero-Leakage Invariant Validation:**
     - Confirms zero orphaned balances or frozen collateral across order book and ledger.
  4. **User Impact Reporting:**
     - Identifies both counterparty addresses and dispatches automated cancellation receipts.

---

## 4. Operational Failure Modes & Escalation Protocols

| Failure Symptom | Immediate Remediation Action | Escalation Contact |
|---|---|---|
| **Rollback state transition rejected** | Verify entity is not in terminal state; run `npm run validate:rollback` | Core Protocol Lead |
| **Orphaned escrow balances detected** | Run `npm run reindex-holders` to reconcile ledger positions against contract state | Settlement Maintainer |
| **Oracle challenge unresolved after 1 hour** | Manually trigger fallback Verra verification adapter via admin console | Oracle Operations |

---

## 5. Post-Drill Sign-off Checklist
- [x] All 3 automated drills executed with exit code `0`.
- [x] Data integrity invariants verified with zero invariant drift.
- [x] Rollback and recovery transitions verified.
- [x] User-impact assessment generated and confirmed.
- [x] Drill execution report archived to operational audit log.
