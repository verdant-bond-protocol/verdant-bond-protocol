# Versioned Migration Notes: Storage Schema v1 -> v2 (#527)

## Scope & Contract Preservation
- **Additive changes** (new `DataKey` entries, new optional fields) keep `SCHEMA_VERSION = 1` and require no migration plan.
- **Breaking changes** (removed keys or altered `xdr_hex` encodings) require:
  1. Bumping the affected contract `SCHEMA_VERSION` and `CURRENT_SCHEMA_VERSION` from `1` to `2` (no version skips).
  2. A `ready` migration plan (`status: "ready"`) with `idempotent: true`, `governanceGated: true`, `resumable: true` for keyed families, and `migrationWindow: true` for in-flight investor state (`HolderBalance`, `RedemptionPool`, `EscrowedCredits`).
  3. A non-empty `rollback` procedure.

## Edge Cases & Recovery / Rollback
- **Version skip / regression**: Rejected by `checkStorageMigrationCompatibility` (`VERSION_SKIP` / `VERSION_REGRESSION`).
- **Retrying partial migrations**: Every step is `idempotent: true` and `resumable: true`, so re-running after a transient RPC/DB failure resumes from the persisted cursor without duplicating state.
- **Unauthorized execution**: Steps with `governanceGated: false` are rejected before execution.
- **Rollback**: Pause the migration window, restore the v1 contract WASM hash and snapshot baseline, and re-run `npm run migration:storage-compat`.
