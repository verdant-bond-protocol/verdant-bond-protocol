# Formal Lifecycle State Machines: Terminal and Recovery Transitions

Resolves **Issue #358**.

## Overview
The Verdant Bond Protocol implements formal lifecycle state machines governing:
1. **Green Bond Lifecycle** (`BondStateMachine`)
2. **Carbon Credit Coupon Verification & Distribution** (`CouponStateMachine`)
3. **Secondary-Market Settlement & Escrow** (`SettlementStateMachine`)

Every state transition is deterministic. Attempting an invalid or undefined transition raises an `InvalidStateTransitionException` providing complete diagnostic context (current state, event attempted, valid allowed events, and whether the current state is terminal).

---

## 1. Green Bond Lifecycle (`BondStateMachine`)

```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> ISSUED: PUBLISH
    DRAFT --> CANCELLED: CANCEL [Terminal]
    ISSUED --> ACTIVE: FUND
    ISSUED --> CANCELLED: CANCEL [Terminal]
    
    ACTIVE --> MATURED: REPAY_FULL [Terminal]
    ACTIVE --> SUSPENDED: SUSPEND
    ACTIVE --> DEFAULTED: MISS_PAYMENT
    
    SUSPENDED --> ACTIVE: RESUME [Recovery]
    SUSPENDED --> DEFAULTED: MISS_PAYMENT
    
    DEFAULTED --> ACTIVE: CURE_DEFAULT [Recovery]
    DEFAULTED --> RESTRUCTURED: RESTRUCTURE [Recovery]
    DEFAULTED --> LIQUIDATED: LIQUIDATE [Terminal]
    
    RESTRUCTURED --> ACTIVE: RESUME
    RESTRUCTURED --> MATURED: REPAY_FULL [Terminal]
    RESTRUCTURED --> DEFAULTED: MISS_PAYMENT
```

### Terminal States
- **`MATURED`:** Reached when all principal and scheduled coupons are fully repaid. Zero outgoing transitions permitted.
- **`CANCELLED`:** Reached if the bond issuance is aborted during draft or fails to reach minimum subscription threshold during auction.
- **`LIQUIDATED`:** Reached if default grace period expires without cure or restructuring; pledged carbon credits/collateral are liquidated to compensate bondholders.

### Recovery Transitions
- **`SUSPENDED` $\xrightarrow{\text{RESUME}}$ `ACTIVE`:** Triggered when temporary holds (e.g. oracle circuit breaker trips, compliance reviews) are resolved.
- **`DEFAULTED` $\xrightarrow{\text{CURE_DEFAULT}}$ `ACTIVE`:** Triggered when the issuer repays missed coupon obligations plus penalty during the grace window.
- **`DEFAULTED` $\xrightarrow{\text{RESTRUCTURE}}$ `RESTRUCTURED`:** Triggered when supermajority bondholder vote approves revised payment terms and covenants.

---

## 2. Carbon Credit Coupon Lifecycle (`CouponStateMachine`)

```mermaid
stateDiagram-v2
    [*] --> SCHEDULED
    SCHEDULED --> ORACLE_VERIFYING: TRIGGER_VERIFICATION
    SCHEDULED --> FAILED: FAIL
    
    ORACLE_VERIFYING --> VERIFIED: CONFIRM_ORACLE
    ORACLE_VERIFYING --> CHALLENGED: CHALLENGE
    ORACLE_VERIFYING --> FAILED: FAIL
    
    VERIFIED --> DISTRIBUTING: START_DISTRIBUTION
    VERIFIED --> CHALLENGED: CHALLENGE
    
    DISTRIBUTING --> DISTRIBUTED: COMPLETE_DISTRIBUTION [Terminal]
    DISTRIBUTING --> FAILED: FAIL
    
    CHALLENGED --> RECONCILED: RESOLVE_CHALLENGE [Recovery]
    CHALLENGED --> FAILED: FAIL
    
    RECONCILED --> DISTRIBUTING: START_DISTRIBUTION
    FAILED --> SCHEDULED: RETRY [Recovery]
```

### Recovery Transitions
- **`CHALLENGED` $\xrightarrow{\text{RESOLVE_CHALLENGE}}$ `RECONCILED`:** Resolves oracle measurement challenges via secondary satellite/IoT verification.
- **`FAILED` $\xrightarrow{\text{RETRY}}$ `SCHEDULED`:** Recovers transient network or contract dispatch failures for idempotent re-execution.

---

## 3. Secondary-Market Settlement Lifecycle (`SettlementStateMachine`)

```mermaid
stateDiagram-v2
    [*] --> PROPOSED
    PROPOSED --> ESCROW_LOCKED: LOCK_ESCROW
    PROPOSED --> REVERSED: CANCEL_ORDER [Terminal]
    
    ESCROW_LOCKED --> SETTLING: EXECUTE_SETTLEMENT
    ESCROW_LOCKED --> REVERSED: CANCEL_ORDER [Terminal]
    
    SETTLING --> SETTLED: CONFIRM_RECEIPT [Terminal]
    SETTLING --> DISPUTED: DISPUTE
    
    DISPUTED --> REVERSED: RESOLVE_ROLLBACK [Recovery/Terminal]
    DISPUTED --> SETTLED: CONFIRM_RECEIPT [Terminal]
```

### Recovery Transitions
- **`DISPUTED` $\xrightarrow{\text{RESOLVE_ROLLBACK}}$ `REVERSED`:** When on-chain settlement anomalies or fraudulent delivery occur, funds and tokenized bond units held in escrow are atomically returned to their respective original owners.

---

## 4. Deterministic Error Diagnostics

When an unpermitted transition occurs:
```typescript
throw new InvalidStateTransitionException(
  currentState, // e.g., 'LIQUIDATED'
  event,        // e.g., 'RESUME'
  allowedEvents,// e.g., []
  isTerminal,   // true
);
```
Output message:
`Invalid state transition from LIQUIDATED via event RESUME. State is terminal. No outgoing transitions permitted.`
This eliminates ambiguous state drift and guarantees strict state-machine conformance.
