# Versioned Record Compatibility — Admin Migration Slice

This document covers a focused addition to the existing schema-versioning layer
(`api/src/common/versioning/schema-versioning.ts`, issue #276) and the guardrails
(`SCHEMA_EVOLUTION_GUARDRAILS.md`, issue #354). It does not replace either: it
adds the operational controls that were missing when an operator actually
migrates a stored versioned record.

Code: `api/src/common/versioning/versioned-record-migration.service.ts`
Tests: `api/src/common/versioning/versioned-record-migration.service.spec.ts`

## Why this slice

The transform helpers are pure and unguarded:

- any caller could downgrade a financial record by calling `applyWriteTransforms`;
- a registry with a missing intermediate transform silently passed data through
  unchanged (`applyReadTransforms` skips absent transforms);
- re-applying a completed migration restamped `migratedAt`, so retries were not
  byte-for-byte stable.

`VersionedRecordMigrationService` wraps the existing helpers with an admin
check, a preflight transform check, and idempotent replay. It is additive: every
existing export, envelope shape and transform table is unchanged.

## Verification paths

| Path | Behaviour |
|---|---|
| Normal | Upgrade V1.0.0/V1.1.0/V1.2.0 → V2.0.0 chains the read transforms; downgrade uses the single matching write transform. `migratedFrom`, `migratedAt` and `transformsApplied` are recorded. |
| Failure | Missing metadata, unsupported target version, or a missing intermediate read/write transform throws `RecordMigrationError` with `invalid_record`, `unsupported_version` or `missing_transform`. |
| Retry | Re-migrating a record already at the target returns the *same object*, `replay: true`, `changed: false` and the original timestamp. Fan-out over identical inputs produces no shared mutation. |
| Authorization | Only an actor whose `roles` include `admin` may migrate. Anonymous and non-admin callers are rejected before the record is read; rejection does not mutate the record. |

Run with:

```bash
cd api && npx jest src/common/versioning/versioned-record-migration.service.spec.ts
```

## Edge cases and recovery

- **No write transform to V2.0.0.** The canonical latest shape deliberately has
  none; a migration already at V2.0.0 is a replay, not an error.
- **Partial migration.** The service is pure: it never writes to storage. The
  caller must persist the returned envelope with a compare-and-set on the
  record version. If the write is lost, re-run the same migration on the stored
  envelope: the result is byte-identical, so no field is migrated twice.
- **Concurrent writers.** Two admins may both compute a migration. The service
  does not arbitrate; the store's CAS decides the winner and the loser re-reads
  the winning envelope, which is then a no-op replay. Callers must not blindly
  overwrite a newer `migratedAt`.
- **Custom entity registries.** Pass `registry` for non-bond entities. A registry
  missing a required step is refused rather than passing data through silently.
- **Clock injection.** `new VersionedRecordMigrationService(() => fixedMs)` makes
  a migration reproducible for incident replay. Never inject a clock that moves
  backwards: a stored envelope's `migratedAt` must remain monotonic.

## Rollback and migration plan

This change is **additive and requires no data migration**:

- No existing signature, export, transform or stored envelope changed.
- Nothing is wired into request handling automatically; callers opt in. To
  disable, stop calling the service. Records already written keep their valid
  `metadata.version` and remain readable by the existing read transforms.
- To roll back a *migration* performed with this service, call it again with the
  original `metadata.migratedFrom` as `targetVersion`. Verify the result with
  `docs/SCHEMA_EVOLUTION_GUARDRAILS.md` (`verifyCompatibility`) before persisting.
- Downgrades of in-flight investor state must still respect the governance
  window and in-flight key rules in `docs/storage-schema-migration-checks.md`.
