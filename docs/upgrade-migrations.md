# Upgrade & migration strategy for the contract suite (#188)

The protocol comprises six interdependent Soroban contracts —
`bond-issuer`, `coupon-engine`, `credit-retirement`, `dex-router`,
`governance`, `oracle-consumer` (plus `project-registry` and the `storage`
support crate). This document defines the upgrade procedure for each of
them, how their interdependencies constrain the upgrade order, and how
in-flight investor state (outstanding tranches, accrued-but-unclaimed
coupons, open secondary-market orders) is preserved across a cutover.

## 1. Versioned interface convention

Every contract exposes:

```rust
pub fn schema_version(env: Env) -> u32 { SCHEMA_VERSION }
```

with the current value defined as a per-contract `SCHEMA_VERSION` constant
and the suite-wide semantics in
`contracts/shared/src/lib.rs::CURRENT_SCHEMA_VERSION`.

Rules:

- A deployment's schema version means: "storage keys and the callable
  interface are compatible with the semantics documented for this version".
- **Additive** changes (new DataKey variants, new entry points, new events)
  keep the version — old clients keep working and old keys are simply absent.
- **Breaking** changes (re-named/re-typed callables, storage key meaning
  changes, argument shape changes) bump `SCHEMA_VERSION` and require a
  migration window (§3).
- Cross-contract calls must only target methods that exist in the caller's
  expected schema; when a callee is upgraded first, its new version must
  retain the old method names or the caller must be upgraded in the same
  cutover (§4 ordering).

## 2. Governance-gated two-phase upgrade

Contract upgrades are executed through the existing governance timelock
(`contracts/governance`, documented in `docs/governance.md`):

1. **Announce** — `propose(target, method, args, description)`. The
   target/method pair must be on the governance allow-list; for upgrades that
   means each contract's `upgrade` entrypoint (or the concrete admin
   migration call) is allow-listed ahead of the release.
2. **Approve & queue** — signers vote with `vote_approve`; once the threshold
   is reached the proposal is queued with `queue`.
3. **Timelock** — the proposal cannot execute before
   `queued_at + timelock_seconds` (default 172 800 s = 48 h). This is the
   public notice window for investors and auditors.
4. **Execute** — `execute` invokes the queued call after the timelock
   elapses, applying the upgrade atomically on-chain.

The same flow is used for the migration-window calls below (§3) so that both
the upgrade and the pause/unpause of coupon flow are publicly announced and
time-locked, never admin-unilateral.

## 3. Migration windows for in-flight state

Contracts holding investor state implement a per-bond migration window
(currently `coupon-engine`; the same pattern applies to `dex-router` open
orders and `bond-issuer` redemptions in future releases):

- `begin_migration(bond_id)` — admin-only, governance-gated. Pauses coupon
  distribution, claims and consumption for the bond and snapshots the
  in-flight state (`MigrationWindow { started_at, snapshot_undistributed,
  snapshot_period_count }`).
- While the window is open, all state-mutating entrypoints return
  `BondError::MigrationInProgress` — in-flight state cannot be lost or
  double-processed during the cutover because nothing can touch it.
- `finalize_migration(bond_id)` — after the upgrade is live and verified,
  resumes the normal flow.
- `rollback_migration(bond_id)` — aborts the window and **proves** the
  snapshot still matches the live undistributed total and period count. A
  mismatch (`Overflow`) means the invariant was violated and halts the
  rollback loudly.

## 4. Upgrade order and interdependencies

Cross-call graph (caller → callee):

| Caller | Callee | Dependency constraint |
| --- | --- | --- |
| `coupon-engine` | `bond-issuer` | reads `total_subscribed`, `get_holder_balance` |
| `coupon-engine` | `oracle-consumer` | reads `get_report`, `get_verification_count` |
| `credit-retirement` | `bond-issuer`, `coupon-engine` | address references |
| `dex-router` | `bond-issuer` | holder balances for settlement |

Upgrade order rules:

1. Upgrade **leaf contracts with no incoming calls first** when the change is
   additive (e.g. `credit-retirement`, `project-registry`).
2. Upgrade **shared data producers** (`oracle-consumer`, `bond-issuer`)
   before their consumers only when the new version keeps the old callable
   surface (additive change). For breaking changes, schedule the caller and
   callee in the same maintenance window and use each contract's migration
   window (§3) so neither side is called mid-upgrade.
3. `governance` itself is upgraded last: it is the gate for every other
   change, and a broken governance contract must never be live without a
   working rollback (§5).
4. Each step is proposed, time-locked and executed separately (§2) so a
   failure between steps leaves the suite in the previous, consistent state.

## 5. Rollback plan

Per contract:

- **Before the cutover**: open the migration window (§3) so investor state is
  frozen and snapshotted on-chain.
- **If the new version misbehaves**: Soroban contract code can be restored by
  re-executing the previous WASM through the same governance flow (propose →
  queue → execute pointing at the prior wasm hash, which the release runbook
  keeps pinned by hash). Because storage was written additively (§1) and the
  migration window forbade writes during the cutover, rolling the code back
  leaves the pre-upgrade state intact.
- **Rollback proof**: `rollback_migration` re-verifies the live state against
  the pre-cutover snapshot and refuses to resume on any divergence. The
  integration test `test_rollback_preserves_in_flight_state` covers this for
  `coupon-engine` (unclaimed coupons, undistributed total and period count
  all preserved and claims still settle afterwards).
- **After rollback**: `finalize_migration`/`rollback_migration` closes the
  window and normal flow resumes; the failed WASM is quarantined and the
  incident documented before a new proposal is announced.

## 6. Checklist

1. Bump `SCHEMA_VERSION` if the change is breaking (§1) and update
   `contracts/tests/fixtures/storage_keys.json` via the storage fixture
   regeneration flow (`cargo test -p nbbs-storage --features
   storage-fixture-update regenerate_storage_fixture_file`).
2. Write the migration window calls into the governance allow-list.
3. Propose `begin_migration` → execute after timelock.
4. Propose the upgrade → execute after timelock.
5. Verify read paths (`schema_version`, key views) against expectations.
6. Propose `finalize_migration` (or `rollback_migration`) → execute.
7. Record deployed wasm hash, schema version and block height in the release
   notes.
