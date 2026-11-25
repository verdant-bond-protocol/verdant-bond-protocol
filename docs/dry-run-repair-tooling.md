# Dry-run repair tooling with checkpoints

**Vertical slice:** a generic, resumable repair runner plus a CLI and one real,
reversible reference job (`holders:dedupe`) operating on a local JSON holder
snapshot. It follows the same safety model as the existing backfill CLI
(`docs/BACKFILL.md`): plan → confirm digest → apply → status/resume → rollback.

## Files

| File | Purpose |
|------|---------|
| `api/src/recovery/repair-tool.interface.ts` | Step/run types, `RepairRefusedError`, `canPlan`/`canApply` authorization. |
| `api/src/recovery/repair-checkpoint.store.ts` | File-backed journal, atomic write-then-rename, safe-id validation. |
| `api/src/recovery/repair-runner.ts` | Strict dry run, digest, checkpointed apply, resume, reverse rollback. |
| `api/src/recovery/repair-jobs.ts` | Reference job: consolidate duplicate holder addresses, summing bigint balances. |
| `api/src/recovery/repair-cli.ts`, `api/scripts/repair.ts` | Executable CLI (`npm run repair -- …`). |
| `api/src/recovery/repair-runner.spec.ts`, `repair-cli.spec.ts` | 23 tests covering the four paths. |

## Usage

```sh
cd api
npm run repair -- list
npm run repair -- plan  --job holders:dedupe --file ./data/holders.json \
  --actor operator --permissions ops:read
# copy the printed plan digest, then:
npm run repair -- apply --job holders:dedupe --file ./data/holders.json \
  --confirm-plan <digest> --actor operator --permissions ops:repair
npm run repair -- status --run <runId> --actor auditor --permissions ops:read
npm run repair -- resume --run <runId> --job holders:dedupe --file ./data/holders.json \
  --actor operator --permissions ops:repair
npm run repair -- rollback --run <runId> --job holders:dedupe --file ./data/holders.json \
  --actor operator --permissions ops:repair
```

Permissions can also come from `REPAIR_ACTOR`, `REPAIR_PERMISSIONS` and
`REPAIR_STATE_DIR`. Exit codes: `0` ok, `1` error, `2` refused, `3` partial,
`4` incomplete (stopped early).

## Paths covered by tests

- **Normal:** plan calls only `inspect`, writes nothing and emits a digest;
  apply persists a checkpoint before the first write and after every step;
  `status`/`list` read it back; healthy steps are skipped.
- **Failure:** a throwing `apply` or `inspect` is checkpointed with its error
  and stops the run; corrupt/unknown checkpoints and path-traversal run ids are
  refused; a digest mismatch refuses the apply before any side effect.
- **Retry:** `resume` retries only pending/failed steps, never re-applies an
  applied one; a stop/resume cycle converges; `revokeToken`-style idempotent
  replays are safe because `inspect` re-checks before each write.
- **Authorization:** read access for plan/status, `ops:repair` for
  apply/resume/rollback; denied commands report "Refused" and leave no files
  or side effects.

## Edge cases

- **Ambiguous failure:** if a step's write succeeded but the process died before
  the checkpoint, `resume` calls `inspect` first and marks the step `skipped`
  rather than applying it twice. This is the same probe-before-retry rule as
  `SideEffectCheckpointService` (`docs/side-effect-recovery.md`).
- **Job drift:** both the digest and the stored `planDigest` are checked on
  resume/rollback, so adding/renaming a step after a run started is refused.
- **Partial rollback:** steps without a compensating action (or whose rollback
  throws) are recorded as conflicts; rollback continues in reverse order and
  the run ends in `failed` with a conflict list instead of pretending success.
- **Large values:** the reference job sums balances with `BigInt`, so no
  precision is lost for values above `Number.MAX_SAFE_INTEGER`.
- **Crash safety:** checkpoints are written to a temp file and renamed, so a
  crash mid-write leaves the previous checkpoint intact.

## Recovery / rollback behaviour

- A dry run never writes to the target snapshot or the checkpoint directory.
- `apply` can be interrupted with SIGINT; it stops after the current step,
  leaves an `incomplete` checkpoint, and `resume` finishes the remaining steps.
- Rollback restores the before-image backup in reverse step order. Because the
  built-in job takes its backup before the first merge, a rollback returns the
  snapshot byte-for-byte to its pre-repair state.
- A failed revoke/repair is safe to retry: all writes are idempotent and the
  checkpoint is the source of truth for what has already happened.

## Contract compatibility / migration

No production API, storage schema or on-chain contract changes — the runner is
an additive operator tool under `api/src/recovery/` plus one npm script.
The reference job uses a JSON snapshot rather than touching Redis/Postgres.
To wire a domain-specific repair, add a `RepairJobFactory` to
`DEFAULT_REPAIR_JOBS` implementing `inspect` (read-only), `apply` (idempotent)
and `rollback` (compensating); no migration is needed for existing data.
