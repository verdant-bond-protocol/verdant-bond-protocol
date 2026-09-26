# Migration Safety (Issue #263)

Schema and data migrations need guardrails: contributors should be able to
preview impact before writing, validate assumptions after writing, and have
the recovery path written down before something breaks.

The repo has no migration tooling today. Schema creation is
`CREATE TABLE IF NOT EXISTS` inside repositories (`oracle-incident.repository.ts`,
`audit/audit-durable-store.ts`), which is safe to re-run but gives no preview,
no post-validation, and no recorded recovery path. This module provides the
guardrail for future migrations and for the ad-hoc DDL that already exists.

## Run phases

Every run executes up to three phases, in order:

| Phase | Always runs? | What it does |
|---|---|---|
| `dry-run` | **Yes — even before a real apply** | Calls `dryRun(context)` and reports affected records/row estimates, without writing |
| `apply` | Only when explicitly requested (`dryRun: false`) | Performs the change |
| `post-check` | Only after a successful apply | Runs **every** registered check, even if an earlier one already failed |

A dry-run is the default. `MigrationSafetyService.run(id)` with no options
touches nothing — writes require the caller to explicitly pass
`{ dryRun: false }`.

## Post-checks

Post-checks detect incomplete or inconsistent migration results: an index that
never materialised, a backfill that stopped halfway, a row count that does not
match the dry-run estimate. A failing check:

- marks the phase (and the whole run) `ok: false`,
- records `detail` describing exactly what failed,
- **does not stop the remaining checks** — one broken check cannot mask a
  second independent inconsistency.

A post-check that *throws* is recorded as a failure (`post-check threw: …`)
rather than crashing the run, so the report always completes.

## Rollback notes

Every `MigrationDefinition` must declare `rollback` — either an undo statement
or an explicit forward-fix note when undo is impossible. It is recorded on
every history entry and returned in the run report, so the recovery path is
next to the failure rather than living in someone's head.

A failed **apply** stops the run before post-checks; the report carries the
apply error and `rollbackNotes`. A failed **post-check** records the check
results and the same notes, since the change itself succeeded but validation
did not.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/migrations/:id/dry-run` | Preview affected records (no writes) |
| `POST` | `/api/v1/migrations/:id/apply` | Apply, with preview first and post-checks after |
| `GET` | `/api/v1/migrations/history` | Every recorded run, newest first |
| `GET` | `/api/v1/migrations/registered` | Registered migration ids |

All routes are JWT + admin guarded: a dry-run enumerates record counts and
table shapes, and applying one is by definition a whole-database mutation.

## Usage

```ts
migrations.register({
  id: 'backfill_coupon_ledger',
  description: 'backfills missing coupon ledger rows',
  rollback: 'No undo needed: the backfill is additive and idempotent.',
  dryRun: async () => [{ target: 'coupon_ledger', estimate: 3400, detail: 'rows missing derived_at' }],
  apply: async () => { /* the write */ },
  postChecks: [
    { name: 'no_rows_missing', check: async () => (missing > 0 ? `${missing} rows still missing` : null) },
    { name: 'counts_match', check: async () => (a !== b ? `${a} != ${b}` : null) },
  ],
});

const report = await migrations.run('backfill_coupon_ledger'); // dry-run
if (report.ok) await migrations.run('backfill_coupon_ledger', { dryRun: false });
```

## What is *not* covered

- **Automatic rollback on failure.** A failing apply or post-check is recorded
  and surfaced, never auto-reversed: an automatic `down()` on a
  half-completed migration is frequently more destructive than the failure it
  is reacting to. Recovery is the recorded manual procedure.
- **A migration runner/scheduler.** This module verifies and records a single
  run on demand. Wiring it into a startup sequence or CI pipeline, and version
  tracking of applied migrations, is separate work once the repo settles on a
  real migration tool.
