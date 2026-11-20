# Migration Release Readiness & Rollback (#514)

The migration safety framework ([#263](./storage-schema-migration-checks.md))
records every dry-run and apply. Release readiness turns that history into a
go/no-go decision for a release and ships the rollback plan with it.

```http
GET /api/v1/migrations/release-readiness?ids=m1,m2&maxDryRunAgeMinutes=1440
```

- `ids` — migrations in the release, **in apply order** (default: every
  registered migration, in registration order). Duplicates are evaluated once.
- `maxDryRunAgeMinutes` — dry-run freshness window (default 24h). Non-positive
  or non-numeric values return `400`.

Logic: [`api/src/migrations/release-readiness.ts`](../api/src/migrations/release-readiness.ts)
(pure, clock injected). Service entry point:
`MigrationSafetyService.evaluateReleaseReadiness()`.

## Checks (all blocking)

| Check | Fails when | Fix |
| --- | --- | --- |
| `registered` | id is in the release but no definition is registered | register it, or drop it from the release |
| `rollback-documented` | rollback note is empty, under 10 chars, or a placeholder (`TODO`, `TBD`, `N/A`, `none`, `TODO: …`) | write the undo SQL or the forward-fix steps |
| `post-checks-defined` | the definition has no post-checks | add at least one invariant check |
| `dry-run-passed` | no dry-run recorded, or the **latest** dry-run failed | fix the cause and re-run `POST /:id/dry-run` |
| `dry-run-fresh` | the latest passing dry-run is older than the window | re-run the dry-run against current data |
| `no-unresolved-failure` | the latest apply failed with no later successful apply | follow the recovery note in `detail`, then retry the apply |

The release is `READY` only when every check of every migration passes;
otherwise `BLOCKED` with the failing ids in `blockers`.

## Retry semantics

A failed apply is resolved by any **later** successful apply of the same
migration. The report counts these as `recoveredFailures` so reviewers can
see a migration was flaky even though it is now green. A later failing
dry-run supersedes an earlier passing one — readiness always reflects the
newest evidence.

## Rollback plan

`rollbackPlan` lists each registered migration's rollback note in **reverse
apply order** (`order: 1` first). Unregistered ids are omitted because there is
no recorded way to undo them, and they already block the release.

## Authorization

The endpoint lives on `MigrationSafetyController`, which is guarded by
`JwtAuthGuard` + `AdminGuard` at class level (asserted in the spec). The
report exposes affected-record history and rollback SQL, so it is never
public. Evaluating readiness is read-only and writes no history.

## Edge cases

- **Empty release** (`ids` resolves to nothing, no migrations registered):
  `READY` with no rows. Treat an empty `migrations` array as "nothing to
  check", not as approval of an unknown set.
- **In-memory history**: `MigrationSafetyService` keeps history in process
  memory. After a restart all migrations report `dry-run-passed: false` until
  dry-runs are re-recorded — this fails closed.
- **Irreversible migrations** must still document a forward-fix in
  `rollback`; that is what the plan will show operators.

## Compatibility

Additive only: no change to `MigrationDefinition`, `MigrationRecord`, run
behaviour, or existing routes. Tests: `api/src/migrations/release-readiness.spec.ts`.
