# Operator-Safe Backfills

`npm run backfill` runs data backfills. It is a dry run by default. `apply`
writes in batches and saves a checkpoint after each batch. Before each batch
it also writes a journal of every record's before and after image. That lets
a run resume after a crash, and lets it be rolled back.

Code: `src/backfill/` (framework-free engine) and `scripts/backfill.ts` (CLI).

## Commands

```bash
npm run backfill -- list                                   # registered jobs
npm run backfill -- plan   --job kyc-record-normalize      # dry run (default command)
npm run backfill -- apply  --job kyc-record-normalize --confirm-plan <digest>
npm run backfill -- apply  --job kyc-record-normalize --resume
npm run backfill -- apply  --job kyc-record-normalize --retry-failed
npm run backfill -- status --job kyc-record-normalize
npm run backfill -- rollback --job kyc-record-normalize --run <runId>
```

| Option | Meaning |
|---|---|
| `--batch-size <n>` | Records per committed batch (default 50). The checkpoint moves only after a batch commits. |
| `--limit <n>` | Process at most `n` records, then stop as `interrupted` (canary). Continue with `--resume`. |
| `--max-failures <n>` | Abort once `n` records are recorded as failed (default 25). |
| `--resume` | Continue an `interrupted` or `aborted` run from its cursor. |
| `--restart` | Discard an unfinished checkpoint and start from the first key. The old journal stays on disk. |
| `--retry-failed` | New run over only the keys the last run recorded as failed. |
| `--confirm-plan <digest>` | Refuse to apply unless a fresh preview has this digest. |
| `--force-unlock` | Take over the lock of a run that is no longer active. |
| `--json`, `--out <file>` | Print the full JSON report, or also write it to a file. |
| `--state-dir <dir>` | Where checkpoints, locks and journals live (default `$BACKFILL_STATE_DIR` or `data/backfill`). |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Completed (or previewed) with no failed records |
| 1 | Unexpected error |
| 2 | Refused: unsafe or ambiguous request. Nothing was written. |
| 3 | Finished, but some records failed (or rollback hit conflicts) |
| 4 | Stopped early: signal, `--limit`, failure threshold or commit failure. Resume needed. |

Automation must treat only `0` as done.

## Standard procedure

1. **Stop writers.** For `kyc-record-normalize`, stop the API. `KycStoreService`
   keeps records in memory and rewrites the whole file on every transition.
   If the API is running during the backfill, the job notices the file
   changing and stops. If the API is started *later* from an old in-memory
   copy, it can overwrite the backfill.
2. **Take a copy** of the store: `cp data/kyc/kyc-records.json kyc-records.pre-backfill.json`.
3. **Preview:** `plan --job <id> --out plan.json`. Review the diff and the
   records it lists as skipped and failed. Note the plan digest.
4. **Canary (optional):** `apply --job <id> --limit 20`, check the results, then `apply --job <id> --resume`.
5. **Apply:** `apply --job <id> --confirm-plan <digest>`. If the data changed
   since you reviewed it, the run is refused rather than applying a plan
   nobody saw.
6. **Handle leftovers.** For skipped records, the reason is the next action
   (they need manual review). Fix failed records at the source, then run
   `--retry-failed`.
7. Restart writers.

## What each job does

### `kyc-record-normalize` (v1)

Brings legacy rows in `kyc-records.json` up to the current `KycRecord` shape:

- `actor`, `reason`, `providerReference` and `expiresAt` → `null` when the field is absent
- missing `source` → `"system"`
- ISO-string or numeric-string timestamps → epoch ms
- a missing `createdAt` or `updatedAt` → copied from the other one

The job leaves `status` alone and never adds or removes a field outside the
schema. Because it changes no status, it writes **no KYC audit entries**: the
audit log records status transitions only. Audit replay at startup uses
`entry.x ?? existing.x`, so it keeps the backfilled values. Public APIs,
response shapes and the file format don't change, so no migration plan is
needed.

| Outcome | When |
|---|---|
| skipped | The address is not a valid Stellar account id, the address does not match its key, or the record has neither timestamp |
| failed | Unknown `status` or `source`, or a timestamp that cannot be parsed |

## Edge cases and failure modes

| Situation | Behaviour | Operator action |
|---|---|---|
| Ctrl-C / SIGTERM | The current batch finishes committing, the checkpoint is saved as `interrupted`, exit 4. A second Ctrl-C exits immediately. | `apply --resume` |
| Crash or kill -9 mid-run | The last saved checkpoint still holds the cursor of the last committed batch. The checkpoint is written to a temp file, fsynced and renamed, so it is never torn. | `apply --resume --force-unlock` (the lock is left behind) |
| Crash between the journal write and the commit | The journal has entries for a batch that was never committed. On resume that batch is re-planned and committed. Rollback treats records already at their before-image as restored. A torn last journal line is ignored. | None |
| Crash between the commit and the checkpoint | That batch is planned again on resume. Its records are now `unchanged` (jobs are idempotent), so nothing is written twice. | None |
| Commit keeps failing (disk full, store changed) | The commit is retried up to 3 times, then the run is `aborted`. The cursor does **not** move past that batch, and its keys are listed as failed. | Fix the cause, then `--resume` |
| Too many bad records | Aborts at `--max-failures`. | Look at the failed list. Fix the data or raise the threshold. |
| Unfinished run exists and `apply` is run again | Refused (exit 2). Must choose `--resume` or `--restart`. | Decide explicitly |
| Job logic changed (version bump) after a partial run | `--resume` is refused, because the old cursor no longer means the same thing. | `rollback` the old run, or `--restart` |
| Two operators at once | The second is refused by the lock file. The message shows the holder's pid, host and start time, and flags a stale lock. | Check that no run is active, then `--force-unlock` |
| Store file missing or corrupt | Refused before anything is planned. | Check `KYC_STORE_DIR` and restore the file |

## Rollback and recovery

Every apply prints its `runId`. Journals live at
`<state-dir>/<job>.<runId>.journal.jsonl`. A later run replaces the
checkpoint, so to find an older run's id, list those files.

```bash
npm run backfill -- rollback --job kyc-record-normalize --run <runId>
```

- Undoes records newest first, so a key journalled twice ends at its original value.
- Restores a record only when its current value still equals the journalled
  after-image. A record edited since the backfill is reported as a
  **conflict** and left alone (exit 3). Review each conflict by hand, using
  the before-image in the journal.
- If the checkpoint belongs to the run being rolled back, it is marked
  `rolled-back`. A later `apply` then starts fresh.
- Stop writers before rolling back, as for apply.

**Last resort:** stop the API and copy `kyc-records.pre-backfill.json` back
over `kyc-records.json`. Any KYC transitions after the backfill are still in
`kyc-audit.log.jsonl`, and the API replays them over the snapshot on its next
startup.

## Adding a job

Implement `BackfillJob<R>` (`src/backfill/backfill.interface.ts`) and register
it in `src/backfill/jobs/index.ts`. Requirements:

- `listKeys` returns a stable key set. Resume uses string order.
- `plan` is pure and idempotent: once a record is backfilled, planning it
  again must return `noop`.
- `commit` is all-or-nothing per batch. It should detect concurrent writers
  and throw rather than overwrite them.
- `restore` puts a before-image back only when the record still equals the
  after-image.
- Bump `version` whenever `plan` changes.
