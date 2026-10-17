# Release Gate for Contract and API Schema Compatibility

## Overview
This document specifies the design, operational workflows, and rollback procedures for the Verdant Bond Protocol **Release Gate for Contract/API Schema Compatibility** (#473).

The release gate acts as an automated, pre-flight deployment verification barrier in CI/CD pipelines and production deployments to ensure that:
1. Deployed Soroban contracts and the NestJS backend API share compatible storage layouts and callable entrypoint interfaces.
2. Breaking schema changes are prevented from going live without an active, governed migration window.
3. Storage fixtures (`contracts/tests/fixtures/storage_keys.json`) remain byte-aligned with on-chain data keys.
4. Any version drift, RPC unreachable condition, or incomplete migration triggers immediate deployment halt with actionable rollback instructions.

---

## Schema Versioning Policy

In accordance with [upgrade-migrations.md](file:///Users/heqmah/verdant-bond-protocol/docs/upgrade-migrations.md):
- **Current Canonical Schema Version**: `1` (`CURRENT_SCHEMA_VERSION = 1`).
- Every protocol contract exposes:
  ```rust
  pub fn schema_version(env: Env) -> u32 { SCHEMA_VERSION }
  ```
- **Additive Changes**:
  - New DataKey variants, new events, new helper functions.
  - Keeps `SCHEMA_VERSION = 1`. Old clients remain fully compatible.
- **Breaking Changes**:
  - Changing argument types, renaming methods, altering storage serialization layouts.
  - Bumps `SCHEMA_VERSION` and requires opening a per-bond migration window (`begin_migration`) before contract cutover.

---

## Release Gate Architecture & Verification Surface

The verification engine is implemented in [`ReleaseGateService`](file:///Users/heqmah/verdant-bond-protocol/api/src/status/release-gate/release-gate.service.ts) and exposed via:
- **API Endpoint**: `GET /status/release-gate` (public/monitoring status)
- **Evaluation Endpoint**: `POST /status/release-gate/evaluate` (admin triggered refresh)
- **Bypass Endpoint**: `POST /status/release-gate/bypass` (emergency override)
- **CI/CD Command**: `npm run release:gate` (`ts-node scripts/verify-release-gate.ts`)

### Contract Verification Matrix

| Contract Target | Required Entry Points | Storage Keys Checked |
|---|---|---|
| `bond-issuer` | `schema_version`, `get_bond`, `subscribe`, `preview_subscribe`, `get_holder_balance`, `mature_bond` | `BondConfig`, `BondState`, `HolderBalance`, `RedemptionPool`, `Admin`, `Nonce` |
| `coupon-engine` | `schema_version`, `distribute_coupon`, `claim_credits`, `claimable_credits`, `sweep_undistributed`, `begin_migration`, `finalize_migration`, `rollback_migration` | `Admin`, `CouponSchedule`, `Undistributed`, `ClaimedCredits` |
| `dex-router` | `schema_version`, `buy_tokens`, `list_tokens` | `OrderBook`, `Admin` |
| `oracle-consumer` | `schema_version`, `get_report`, `submit_report` | `Report`, `ProviderRegistry` |
| `governance` | `schema_version`, `propose`, `execute` | `Proposal`, `Vote`, `Timelock` |
| `credit-retirement` | `schema_version`, `retire_credits` | `RetirementRecord` |
| `project-registry` | `schema_version`, `get_project` | `ProjectConfig`, `Verifier` |

---

## Verification Paths & Operational Edge Cases

### 1. Normal Path (All Compatible)
- All seven contracts return `schema_version = 1`.
- All required callable interfaces match expected signatures.
- Storage fixtures match `storage_keys.json` canonical definitions.
- No migration windows are active in an unfinalized state.
- **Result**: `gateStatus: COMPATIBLE`, exit code `0`. Deployment proceeds.

### 2. Failure Path (Incompatibility Detected)
- **Version Drift**: A contract was upgraded on-chain to version 2 while API expects version 1.
  - *Gate Status*: `INCOMPATIBLE`, exit code `1`.
  - *Action*: Release pipeline halts. Detailed violation specifies:
    ```
    Contract [bond-issuer] deployed schema version 2 does not match supported version 1
    ```
- **Missing Callable / Broken Interface**: A contract was deployed without required methods or with altered parameters.
  - *Gate Status*: `INCOMPATIBLE`, exit code `1`.
- **Storage Drift**: A DataKey was added or modified without updating `storage_keys.json`.
  - *Gate Status*: `INCOMPATIBLE`, exit code `1`.

### 3. Migration Window Active (`MIGRATION_ACTIVE`)
- If `coupon-engine` or `dex-router` has an active migration window (`is_active = true`), writes to coupon flow or orders are paused.
- The gate emits status `MIGRATION_ACTIVE` (`overallCompatible = false`), preventing new production API deployments from routing live traffic until governance finalizes or rolls back the window (`finalize_migration` or `rollback_migration`).

### 4. Controlled Bypass (`BYPASSED`)
- For staging canary testing or non-breaking emergency hotfixes:
  ```bash
  curl -X POST https://api.verdantbond.org/status/release-gate/bypass \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "enable": true,
      "reason": "Canary deployment of experimental oracle connector v2",
      "expiresAt": "2026-10-18T00:00:00Z"
    }'
  ```
- The evaluation reports `gateStatus: BYPASSED`, includes operator attribution, and preserves overridden violations in the audit payload.

---

## Rollback & Recovery Playbook

If the release gate blocks deployment in staging or production:

### Scenario A: Unintended Breaking Contract Upgrade
1. **Identify the offending contract**: Inspect `evaluation.violations` and `evaluation.rollbackRecommendations`.
2. **Retrieve prior WASM hash**: Lookup the pinned WASM hash from the previous release tag in Git.
3. **Submit governance proposal**:
   ```bash
   soroban contract invoke --id $GOVERNANCE_ADDR --source admin -- \
     propose --target $OFFENDING_CONTRACT_ADDR --method upgrade --args "[\"<PRIOR_WASM_HASH>\"]"
   ```
4. **Execute after timelock**: Once approved, execute the upgrade to restore the prior WASM.
5. **Re-run Release Gate**:
   ```bash
   npm run release:gate
   ```
   Confirm exit code is `0` and status is `COMPATIBLE`.

### Scenario B: In-Flight Migration Stall
If a contract migration was started (`begin_migration`) but did not complete:
1. Verify whether in-flight state is intact:
   ```bash
   npm run validate:rollback
   ```
2. If the upgrade cannot proceed, execute `rollback_migration(bond_id)` via governance timelock.
3. `rollback_migration` verifies the snapshot matches live balances and safely aborts the migration window.
4. Verify that `GET /status/release-gate` clears `MIGRATION_ACTIVE`.
