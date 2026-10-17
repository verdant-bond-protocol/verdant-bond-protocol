# Matured Bond Archival and Restore Verification Runbook

## Overview
This document specifies the operational procedures, invariant guarantees, and recovery playbooks for archiving matured bond records and verifying their byte-for-byte and cryptographic restoration in the Verdant Bond Protocol.

## Background & Objectives
Once a bond tranche reaches maturity (`BondMaturityStatusEnum.Matured` or `BondStatusEnum.Matured`) and all coupon distribution periods have completed or sweeps of undistributed credits have been finalized, hot state in application cache/Redis and active indexing can be transitioned to an archived tier.

Archival must strictly uphold:
1. **Financial Invariants**: No bond with pending unclaimed sweep credits or unresolved liabilities can be archived until administrative sweep/settlement completes.
2. **Cryptographic Integrity**: Archival packages are sealed with SHA-256 cryptographic digests computed across all canonical fields (bond ID, project ID, total supply, face value, coupon schedule, and terminal balances).
3. **Restoration Verification**: Restoration can only occur if the checksum matches the manifest digest and the caller possesses administrative authority (`ADMIN` role).
4. **Idempotency & Replay Safety**: Repeating archival or restoration requests with identical idempotency parameters yields the verified state without mutating audit logs or corrupting counters.

---

## Architecture

### 1. State Lifecycle Transitions
```
                +-------------------+
                |      Active       |
                +-------------------+
                          |
                          v
                +-------------------+
                |      Matured      |
                +-------------------+
                          |
        [archiveRecord / verify zero sweeps]
                          v
                +-------------------+
                |     Archived      | <------+
                +-------------------+        |
                    |           ^            |
  [verifyRestore]   |           | [re-archive|
                    v           |  idempotent]
                +-------------------+        |
                |     Restored      |--------+
                |    (Re-activated) |
                +-------------------+
```

### 2. Service Implementation
Implemented in [`MaturedBondArchivalService`](file:///Users/heqmah/verdant-bond-protocol/api/src/bonds/matured-bond-archival.service.ts):
- `archiveMaturedRecord(bondId, reason, operatorAddress, retentionPolicy)`
- `verifyRestore(bondId, snapshotPayload)`
- `restoreMaturedRecord(bondId, snapshotPayload, operatorAddress)`
- `isBondArchived(bondId)`
- `getLifecycleState(bondId)`

---

## Operational Paths & Edge Cases

### 1. Normal Path (Matured Bond Archival)
1. **Pre-check**: Bond status must be `Matured` (or `Active` with `maturityDate <= now`).
2. **Sweep Verification**: Query `bondsService.getUndistributedTotal(bondId)`. If `totalCredits > 0`, archival is blocked with `400 Bad Request` until `sweepUndistributed` is invoked.
3. **Digest Generation**: SHA-256 hash calculated over canonicalized JSON representation.
4. **Lifecycle State Transition**: Record tagged as `Archived`, cached state invalidated, compliance snapshot emitted (`BOND_ARCHIVED`).
5. **Cold Storage Manifest**: Emits manifest containing `checksum`, `archivedAt`, `operatorAddress`, and `retentionPolicy`.

### 2. Failure Paths & Rejections
- **Non-Matured Bond**:
  - *Trigger*: Attempting to archive a bond whose maturity date is in the future and whose status is not `Matured`.
  - *Response*: `400 Bad Request: Only matured bonds can be archived`.
- **Unclaimed / Pending Sweep Balance**:
  - *Trigger*: `getUndistributedTotal(bondId)` reports remaining credit balance.
  - *Response*: `400 Bad Request: Cannot archive bond with outstanding undistributed coupon credits`.
- **Tampered Restore Payload**:
  - *Trigger*: `verifyRestore` called with payload whose SHA-256 digest fails to match the manifest digest.
  - *Response*: `400 Bad Request: Checksum mismatch in restore payload`.
- **Unauthorized Operator**:
  - *Trigger*: Non-admin wallet invokes `POST /bonds/:id/archive` or `POST /bonds/:id/restore`.
  - *Response*: `403 Forbidden: Insufficient role permissions`.

### 3. Retry and Idempotency
- **Duplicate Archive Call**:
  - If a bond is already in `Archived` state, calling `archiveMaturedRecord` returns the existing archival manifest and checksum without error (`200 OK`).
- **Duplicate Restore Call**:
  - If a bond is already active/restored, calling `restoreMaturedRecord` with a valid digest returns the current record state idempotently.

---

## Rollback & Emergency Recovery Playbook

### Scenario A: Unintended Archival of Active Production Bond
If a bond was prematurely archived due to administrative misconfiguration:
1. Retrieve the archival snapshot from cold storage / audit log.
2. Execute dry-run verification:
   ```bash
   curl -X POST https://api.verdantbond.org/bonds/<BOND_ID>/verify-restore \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d @snapshot_<BOND_ID>.json
   ```
3. Inspect response for `"valid": true` and `"checksumMatch": true`.
4. Execute live restoration:
   ```bash
   curl -X POST https://api.verdantbond.org/bonds/<BOND_ID>/restore \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d @snapshot_<BOND_ID>.json
   ```
5. Confirm bond status and portfolio indices are refreshed:
   ```bash
   curl -X GET https://api.verdantbond.org/bonds/<BOND_ID>/lifecycle \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

### Scenario B: Storage Bit-Rot or Checksum Discrepancy
If a cold backup fails checksum verification during disaster recovery:
1. Do NOT force restoration into active state.
2. Reconstruct the canonical state from Soroban on-chain storage:
   - Query `bond_issuer` contract method `get_bond(bond_id)`.
   - Query `coupon_engine` contract method `get_total_undistributed(bond_id)`.
3. Compute the reference checksum from the on-chain canonical state.
4. Reseal the archive package with the verified on-chain digest and update the manifest before re-running `verify-restore`.
