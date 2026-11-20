# Cross-Service Contract Map for Domain Events and Integration Boundaries

Resolves **Issue #368**.

## 1. Architecture and Integration Boundaries

The Verdant Bond Protocol spans on-chain Soroban smart contracts, off-chain environmental telemetry feeders, an append-only cryptographic event ledger, compliance/settlement services, and investor-facing interfaces.

To prevent brittle point-to-point couplings, all cross-service boundaries conform to a formal contract map (`api/src/common/contracts/cross-service-contract-map.ts`) governing:
- Explicit **Producer and Consumer Topologies**
- Strictly typed **Payload Schemas** with field-level validations
- Deterministic **SemVer Evolution Rules**
- Allowed **Failure Behaviors** (`fail-closed`, `dead-letter-retry`, `circuit-breaker-pause`)

```mermaid
flowchart TD
    subgraph Soroban["On-Chain Smart Contracts"]
        BI[BondIssuer]
        CE[CouponEngine]
        OC[OracleConsumer]
        DEX[DEXRouter]
    end

    subgraph Oracle["Oracle Feeders"]
        DF[DataFeeder]
        ST[Sentinel]
    end

    subgraph API["Backend API & Workers"]
        LEDGER[EventLedger]
        SETTLE[SettlementService]
        COMP[ComplianceService]
        NOTIF[NotificationDispatcher]
    end

    subgraph Clients["Consumers"]
        PORTAL[InvestorPortal]
        STATUS[PublicStatusFeed]
    end

    BI -->|bond.issued\n[fail-closed]| LEDGER
    BI -->|bond.issued\n[synchronous]| CE
    BI -->|subscription.allocated\n[fail-closed]| LEDGER
    BI -->|websocket| PORTAL

    CE -->|coupon.distributed\n[dead-letter-retry]| LEDGER
    CE -->|redis-pubsub| NOTIF
    NOTIF -->|push| PORTAL

    DF -->|oracle.report_submitted\n[circuit-breaker-pause]| OC
    DF -->|redis-pubsub| LEDGER
    DF -->|webhook| STATUS

    OC -->|oracle.provider_slashed\n[fail-closed]| LEDGER
    OC -->|webhook| STATUS

    DEX -->|order.filled\n[fail-closed]| LEDGER
    DEX -->|redis-pubsub| SETTLE

    COMP -->|kyc.override\n[fail-closed]| LEDGER
```

---

## 2. Authoritative Contract Matrix

| Event Name | Producer | Consumers | Channels & Modes | SemVer Rule | Allowed Failure Behavior |
|---|---|---|---|---|---|
| `bond.issued` | `contract:BondIssuer` | `api:EventLedger`, `contract:CouponEngine`, `client:InvestorPortal` | `stellar-event-stream` (async), synchronous contract call, `websocket-push` (async) | `additive-only` | **`fail-closed`** |
| `subscription.allocated` | `contract:BondIssuer` | `api:EventLedger`, `client:InvestorPortal` | `stellar-event-stream` (async), `websocket-push` (async) | `additive-only` | **`fail-closed`** |
| `coupon.distributed` | `contract:CouponEngine` | `api:EventLedger`, `api:NotificationDispatcher`, `client:InvestorPortal` | `stellar-event-stream` (async), `redis-pubsub` (async), `websocket-push` (async) | `additive-only` | **`dead-letter-retry`** |
| `oracle.report_submitted` | `oracle:DataFeeder` | `contract:OracleConsumer`, `api:EventLedger`, `client:PublicStatusFeed` | `stellar-event-stream` (sync), `redis-pubsub` (async), `rest-webhook` (async) | `additive-only` | **`circuit-breaker-pause`** |
| `oracle.provider_slashed` | `contract:OracleConsumer` | `api:EventLedger`, `client:PublicStatusFeed` | `stellar-event-stream` (async), `rest-webhook` (async) | `immutable-strict` | **`fail-closed`** |
| `order.filled` | `contract:DEXRouter` | `api:EventLedger`, `api:SettlementService`, `client:InvestorPortal` | `stellar-event-stream` (async), `redis-pubsub` (async), `websocket-push` (async) | `immutable-strict` | **`fail-closed`** |
| `kyc.override` | `api:ComplianceService` | `api:EventLedger`, `client:InvestorPortal` | `ledger-append` (sync), `rest-webhook` (async) | `additive-only` | **`fail-closed`** |

---

## 3. Allowed Failure Behaviors

1. **`fail-closed` (Atomic Revert)**:
   - Reserved for financial settlements, token issuance, slashing, and compliance state mutations.
   - If contract assertion, schema validation, or ledger append fails, the transaction is rejected immediately. No partial state is stored.
2. **`dead-letter-retry` (Asynchronous DLQ)**:
   - Applied to asynchronous consumer notifications (e.g. email/webhook alerts, investor push notifications).
   - Failed events enter a Redis-backed DLQ (`queue:dlq:events`) and retry up to 5 times with exponential backoff and randomized jitter before alerting operators.
3. **`circuit-breaker-pause` (System Degradation / Pause)**:
   - Applied to external data feeds (environmental sensors, satellite telemetry, oracle providers).
   - If a provider reports anomalous variances or fails consecutive submission deadlines, the circuit breaker opens: the protocol marks the oracle feed as `degraded` or `paused`, protecting downstream bond coupons from mispricing.

---

## 4. SemVer Evolution Rules

1. **`additive-only`**:
   - New fields added to `payloadSchema` must be marked optional (`required: false`).
   - Existing fields must not be renamed or removed within the same major version.
   - Breaking changes require a major version increment (e.g. `2.0.0`) and dual-write support.
2. **`immutable-strict`**:
   - Cryptographic hashes, settlement records, and slashing events are immutable. Field schemas cannot change without migrating the underlying contract ledger.
3. **`deprecate-with-fallback`**:
   - Fields marked for deprecation must retain fallback resolution to the canonical replacement across at least two minor version cycles before deprecation enforcement.

---

## 5. Operational Edge Cases

1. **Out-of-Order Event Processing**:
   - In distributed event streams, `subscription.allocated` could arrive before `bond.issued`.
   - *Mitigation*: The `EventLedger` verifies causal dependencies; orphan child events are staged in an unconfirmed cache until parent sequence confirmation arrives.
2. **Replay Attacks**:
   - An attacker re-submitting an existing Soroban event transaction hash to trigger duplicate credits.
   - *Mitigation*: The ledger indexes transaction hashes and sequence nonces; duplicate event IDs are rejected as idempotent no-ops.
3. **Consumer Lag**:
   - Downstream notification workers lagging behind during high-volume primary issuance auctions.
   - *Mitigation*: Redis pub/sub streams buffer events with stream consumer groups (`XREADGROUP`), allowing autoscaled worker nodes to catch up without message loss.

---

## 6. Failure Modes and Rollback/Recovery Runbook

### Scenario 1: Schema Incompatibility on Consumer Path
- **Symptom:** Worker logs report `Incompatible schema version: contract requires major version 1.x, event supplied 2.0.0`.
- **Action:**
  1. Inspect the DLQ queue:
     ```bash
     redis-cli LRANGE "queue:dlq:events" 0 50
     ```
  2. If an unannounced major version was deployed, roll back producer deployment.
  3. Replay DLQ events once compatible consumer versions are running:
     ```bash
     npm run seed -- --replay-dlq
     ```

### Scenario 2: Circuit Breaker Tripped on Oracle Feeds
- **Symptom:** `oracle.report_submitted` enters `circuit-breaker-pause`. Status feed reports `oracle-monitoring: down`.
- **Action:**
  1. Audit oracle provider telemetry hash against IPFS.
  2. If satellite provider is restored, invoke admin resume probe via `POST /status/component/oracle-monitoring/resume`.
  3. Verify contract map compliance:
     ```bash
     node --experimental-strip-types scripts/verify-contract-map.mjs
     ```

---

## 7. Compatibility Statement

- All cross-service contract definitions are strictly backwards-compatible with existing on-chain Soroban event topic formats (`docs/event-schemas.md`) and internal ledger structures (`api/src/ledger/ledger.types.ts`).
