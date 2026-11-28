# Sensitive Configuration Audit Evidence (#528)

`SensitiveConfigAuditService` (`api/src/config/sensitive-config-audit.service.ts`) records tamper-evident, hash-chained audit entries for runtime sensitive configuration changes (`JWT_EXPIRY`, `MAX_SLIPPAGE_BPS`, `ORACLE_QUORUM`, `MAINTENANCE_MODE`, `FEE_TREASURY_ADDRESS`, `SIGNING_SECRET_ROTATION_KEY`).

## Guarantees
- **Fail-closed evidence**: In-memory config state is mutated only after the audit entry is persisted (`persistHook`).
- **Secret redaction**: Secret-shaped keys are always stored as `[REDACTED]` in `before`/`after` snapshots.
- **Idempotency & conflict detection**: Replaying the same `changeId` + payload returns `replayed`; reusing a `changeId` with a different payload throws `SensitiveConfigConflictError`.
- **Rollback**: `rollbackChange` verifies the full hash chain via `verifyChain()` before restoring keys and appending a `config.rolled_back` entry.
- **Authorization**: Only `ADMIN` actors may apply or roll back sensitive configuration changes.
