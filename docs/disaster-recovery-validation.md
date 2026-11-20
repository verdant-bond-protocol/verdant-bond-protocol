# Disaster Recovery & Core Domain Invariants Validation

This document describes the disaster recovery (DR) validation framework, restore assumptions, core domain invariants, failure interpretation, and maintainer escalation procedures for the **Verdant Bond Protocol**.

---

## 1. Overview & Purpose

Following a disaster recovery event, failover migration, or snapshot restore (database, Redis, or IPFS node restoration), maintainers must verify that restored state conforms strictly to domain rules before resuming public API mutations, secondary market trading, and Stellar settlement orchestration.

The protocol provides a **read-only by default** validation engine (`DomainInvariantsService`) and operational CLI tool (`scripts/validate-recovery.ts` / `npm run validate:recovery`) that interrogates restored records, entity relationships, and settlement references without writing or modifying production data.

---

## 2. Recovery Assumptions

The validation framework is designed under the following core architectural assumptions:

1. **Stellar Ledger is Authoritative for Value and Ownership**:
   - The Stellar blockchain (Soroban smart contracts `BondIssuer`, `CouponEngine`, and `DexRouter`) is the immutable source of truth for token balances, authorized supply, bond state, and settlement execution.
   - Redis and the relational store act as performant query caches, read models, and audit indexers.
2. **Cold Backups & Snapshot Ordering**:
   - Restore sequence must follow:
     1. IPFS cluster pinning restore (project impact documents and geospatial boundary manifests).
     2. Primary relational database / KYC store snapshots (`kyc-records.json`, `kyc-audit.log.jsonl`).
     3. Redis cache rehydration and nonce counter synchronization.
     4. On-chain state reconciliation via `reindex-holders`.
3. **Read-Only Validation Guarantee**:
   - Validation checks (`validateDomainInvariants` and `scripts/validate-recovery.ts`) **never** execute state-changing transactions, mutate Redis keys, or sign on-chain transactions. Dry-run mode is enforced by default (`dryRun: true`).
4. **Zero-Trust Post-Restore**:
   - Maintainers must assume restored caches may contain partial writes or stale data from mid-flight operations prior to backup cut-off.

---

## 3. Core Domain Invariants Catalog

The validation suite enforces five core domain invariant groups across the lifecycle of green bonds, investor portfolios, and DEX order books:

### Invariant 1: Bond-to-Project Referential Integrity (`BOND_PROJECT_INTEGRITY`)
- **Missing Check**: Every project registered in the project registry must have non-empty metadata, valid country/methodology specifications, and resolvable IPFS content identifiers (CIDs).
- **Orphaned Check**: Every bond must reference a valid, existing `projectId`. Any bond referencing an unknown or un-restored project is flagged as `orphaned`.
- **Duplication Check**: Every bond ID must be unique. No duplicate bond IDs may exist in registry indices.

### Invariant 2: Bond Supply & Investor Holding Accounting (`BOND_SUPPLY_ACCOUNTING`)
- **Supply Cap Constraint**: For every bond:
  $$\text{totalSubscribed} \le \text{totalSupply}$$
  If $\text{totalSubscribed} > \text{totalSupply}$, a `CRITICAL` inconsistent drift is raised.
- **Strict Conservation of Principal**: The sum of all individual investor balances in the holder index must exactly match the recorded `totalSubscribed`:
  $$\sum_{i=1}^{N} \text{balance}_i = \text{totalSubscribed}$$
- **Non-Negativity Constraint**: Individual investor balances must never be negative:
  $$\forall i, \quad \text{balance}_i \ge 0$$
- **Maturity Status Consistency**: A bond must not be marked `Matured` if `ledger.timestamp < maturityDate` unless an early redemption or emergency maturity event has been recorded on-chain.

### Invariant 3: Marketplace Order Book Integrity (`MARKETPLACE_ORDER_INTEGRITY`)
- **Orphaned Order Check**: Every open order must reference an existing, valid bond ID. Orders pointing to non-existent bonds are flagged as `orphaned`.
- **Order Identity Uniqueness**: Order sequence IDs must be globally unique without collision.
- **Positive Order Quantities**: All order amounts must be strictly positive integers ($\text{amount} > 0$).
- **Stale Expiration Detection**: Any order marked `Open` whose wall-clock timestamp exceeds `expiresAt` is flagged as `stale` to prevent executing expired trades.

### Invariant 4: Settlement Reference Integrity (`SETTLEMENT_REFERENCE_INTEGRITY`)
- **Format Verification**: Every recorded on-chain settlement reference (bond subscriptions, coupon claims, secondary market trades, treasury sweeps) must be a 64-character hexadecimal transaction hash matching `^[0-9a-fA-F]{64}$`.
- **Anti-Collision / Replay Detection**: Transaction hashes must map 1-to-1 to a distinct business event. If two separate operations claim the same transaction hash, a `CRITICAL` duplicate settlement reference is raised.
- **Presence Check**: Mutating actions must have their corresponding transaction hash recorded and retrievable.

### Invariant 5: KYC & Compliance Monotonicity (`KYC_COMPLIANCE_INTEGRITY`)
- **Single Identity Invariant**: Each wallet address must possess at most one active KYC record.
- **Status Validity**: KYC status must belong to the valid state machine (`NONE`, `PENDING`, `REJECTED`, `EXPIRED`, `VERIFIED`, `ACCREDITED`).
- **Audit Log Monotonicity**: The append-only audit trail (`kyc-audit.log.jsonl`) must exhibit non-decreasing timestamps for each wallet address.

---

## 4. How to Run Disaster Recovery Validation

### Option A: Standalone CLI Script (Recommended for Maintainers)

The script connects to restored services in **read-only mode** and produces a formatted audit report:

```bash
# Standard interactive check with summary tables:
npm run validate:recovery

# Output machine-readable JSON (ideal for CI/CD or automated failover gates):
npm run validate:recovery -- --json

# Strict mode (exits with non-zero exit code on ANY drift, even minor/stale warnings):
npm run validate:recovery -- --strict

# Direct invocation via ts-node:
npx ts-node scripts/validate-recovery.ts
```

### Exit Codes:
- `0`: **HEALTHY** - All domain invariants satisfied; restored state is consistent.
- `1`: **INVARIANT VIOLATION** - Critical or inconsistent drifts detected (or any drift if `--strict` is enabled).
- `2`: **EXECUTION FAILURE** - Connection failure or unhandled system error.

### Option B: Admin API Endpoints

Maintainers can trigger validation via the authenticated administrative API:

```http
# Trigger read-only domain invariants check:
GET /api/v1/reconciliation/validate-restore
Authorization: Bearer <ADMIN_JWT>

# Trigger dry-run reconciliation report:
POST /api/v1/reconciliation/dry-run
Authorization: Bearer <ADMIN_JWT>
```

---

## 5. Interpreting Validation Failures

When validation detects drifts, each finding is classified into one of five categories:

| Category | Severity | Meaning | Example Finding |
|---|---|---|---|
| `missing` | High / Medium | An entity expected by domain invariants is absent from restored storage. | Project metadata CID unresolvable; missing settlement transaction hash. |
| `orphaned` | High | A child record references a parent ID that does not exist in restored records. | Bond references `projectId: 99` which does not exist in the project registry. |
| `duplicate` | High / Critical | An identifier or reference is duplicated across distinct records. | Two distinct subscriptions share the same Stellar transaction hash; duplicate bond ID. |
| `inconsistent`| Critical | Data violates fundamental arithmetic, financial, or state machine invariants. | Sum of holder balances $\neq$ `totalSubscribed`; negative investor balance; `totalSubscribed > totalSupply`. |
| `stale` | Low / Medium | A record contains out-of-date status relative to the current wall-clock. | Order marked `Open` despite timestamp being past `expiresAt`. |

---

## 6. Maintainer Escalation Runbook

When post-restore validation returns status `CRITICAL` or `DEGRADED`, maintainers must follow this escalation protocol:

```
                          [Run Validation]
                                 │
                     Is Status == HEALTHY (Exit 0)?
                                ╱ ╲
                             Yes   No
                             ╱       ╲
            [Enable Traffic & API]    [Triage Failure Category]
                                          │
            ┌─────────────────┬───────────┴───────────┬─────────────────┐
            ▼                 ▼                       ▼                 ▼
       [Inconsistent]     [Orphaned]             [Duplicate]        [Missing]
            │                 │                       │                 │
     1. Halt mutations 1. Identify parent   1. Check nonce      1. Restore from
     2. Query on-chain    record from logs     counter sync        cold backup
        ledger         2. Quarantine child  2. Verify replay    2. Re-pin IPFS
     3. Run reindex-      entity               protection          manifests
        holders        3. Unlock collateral 3. Prune duplicates
            │                 │                       │                 │
            └─────────────────┴───────────┬───────────┴─────────────────┘
                                          │
                              [Re-run Validation]
                                          │
                                 Status == HEALTHY?
                                        ╱   ╲
                                     Yes     No
                                     ╱         ╲
                       [Resume Operations]    [Escalate to Core Engineering]
```

### Specific Remediation Steps:

1. **Inconsistent Balances or Supply (`BOND_SUPPLY_ACCOUNTING`)**:
   - **Immediate Action**: Keep public API mutations paused.
   - **Remediation**: Run the authoritative on-chain holder reindexing tool:
     ```bash
     npm run reindex-holders
     ```
   - **Verification**: Re-run `npm run validate:recovery` to confirm $\sum \text{balances} = \text{totalSubscribed}$.

2. **Orphaned Orders or Bonds (`MARKETPLACE_ORDER_INTEGRITY` / `BOND_PROJECT_INTEGRITY`)**:
   - **Remediation**: Quarantine orphaned listings. If orders reference an un-restored bond, execute order cancellation to return escrowed quote tokens to buyer/seller wallets.
   - **Escalation**: Check if the project database backup was taken at a different timestamp than the bond database backup.

3. **Duplicate Settlement References (`SETTLEMENT_REFERENCE_INTEGRITY`)**:
   - **Remediation**: Query Horizon/Soroban RPC for the transaction hash details.
   - **Escalation**: If two different user requests claim the exact same transaction hash, inspect the ledger envelope to identify the genuine caller; rollback the phantom entity.

4. **Stale Orders or Expirations**:
   - **Remediation**: Trigger the automated order expiration cleanup job or worker to transition expired orders to `Expired`.
