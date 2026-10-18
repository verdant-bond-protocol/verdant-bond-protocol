# Secure import pipeline

Operators sometimes have to load a lot of compliance data at once. A common
case is a KYC provider's attestation export, where one file updates hundreds
of investors. Writing such a file straight into the KYC store causes three
problems. One bad row (a shifted column, a spreadsheet formula, a typo'd
address) silently corrupts eligibility. Nobody can tell afterwards which file
changed a record. And a bad file has no undo.

The pipeline handles imports in two phases. A **preview** writes nothing and
labels every row *accepted* or *quarantined*. A **commit** then applies only
the accepted rows, and only the preview the operator reviewed. Each applied
row leaves a **trace**, and that trace is what makes **retry** and
**rollback** safe.

Code: `api/src/imports/`
- `import-pipeline.service.ts`: state machine, commit/retry/rollback
- `import-safety.ts`: CSV parser, row-safety checks, limits
- `kyc-import.sink.ts`: the `kyc_attestation` import kind
- `imports.controller.ts`: HTTP API

Tests: `api/src/imports/*.spec.ts` (run `cd api && npx jest src/imports`).
The pipeline spec runs against the real `KycService`, `KycStoreService` (in a
temp directory) and `AuditService`. Only Redis is faked.

## Lifecycle

```
preview ──► previewed ──commit──► committing ──► committed ───────────┐
               │                     │                                │
            discard            row failure                         rollback
               ▼                     ▼                                ▼
           discarded       partially_committed ──rollback──► rolling_back ─► rolled_back
           (or expired          │      ▲                                └──► rollback_incomplete
            after 30 min)       └commit┘ (= retry)                              (re-run rollback)
```

| Status | Meaning | Allowed next |
|--------|---------|--------------|
| `previewed` | Rows classified, nothing written | commit, discard |
| `expired` | Preview older than 30 min (`PREVIEW_TTL_MS`) | discard; re-submit the file |
| `committing` | Commit running; the batch is locked | — (concurrent calls get 409) |
| `committed` | Every accepted, non-noop row applied or quarantined at commit | rollback |
| `partially_committed` | A row failed to apply; rows before it are applied | commit (retry), rollback |
| `rolling_back` | Rollback running; the batch is locked | — |
| `rolled_back` | Every applied row restored | — |
| `rollback_incomplete` | Some rows could not be restored safely | rollback (re-run) |
| `discarded` | Operator abandoned the preview | — |

## API

All routes are under `api/v1/imports`. All of them require `JwtAuthGuard` and
`AdminGuard`, because one import changes compliance state for many investors.
The **actor** always comes from the token, never from the request body.

| Method & path | Purpose |
|---------------|---------|
| `GET  /kinds` | Import kinds and their exact column sets |
| `POST /:kind/preview` | `{ format: 'json', rows: [...] }` or `{ format: 'csv', csv: '...' }`, optional `sourceName` |
| `GET  /` | Batch list (no rows) |
| `GET  /:id` | Full batch: rows, verdicts, reasons, before/after, trace |
| `GET  /:id/quarantine` | Only the quarantined rows, with their raw input |
| `POST /:id/commit` | `{ previewHash, allowDuplicate? }`. Commits, or **resumes** a `partially_committed` batch |
| `POST /:id/rollback` | `{ previewHash }`. Undoes applied rows. Re-run it to resume |
| `POST /:id/discard` | Abandons a preview |
| `GET  /trace?key=<address>` | Every retained import that wrote to that record |

`commit` and `rollback` both require the batch's `previewHash`, a sha256 over
the batch id and every row's fingerprint, verdict and action. You can only
act on a preview you have actually read. You cannot reuse a hash from another
batch or from a stale browser tab.

A commit that hits a row failure does **not** return an error. It returns
`200` with `status: "partially_committed"` and `lastError`. Always check
`status`.

| Error | HTTP | When |
|-------|------|------|
| `INVALID_REQUEST` | 400 | Unknown kind, malformed payload, limits exceeded (nothing is staged) |
| `NOT_FOUND` | 404 | Unknown batch id (or evicted, see Limits) |
| `PREVIEW_MISMATCH` | 409 | `previewHash` missing or wrong |
| `INVALID_STATE` | 409 | Action not allowed in the current status, including concurrent commit/rollback |
| `DUPLICATE_IMPORT` | 409 | Identical accepted content was already committed. Pass `allowDuplicate: true` to proceed |
| `PREVIEW_EXPIRED` | 410 | Commit after the 30 min preview TTL |
| `DISABLED` | 503 | `IMPORT_PIPELINE=off` |
| `CAPACITY` | 503 | 200 retained batches still need action |

## What gets quarantined

Every row runs through schema-independent safety checks first, then the
import kind's schema, then policy checks against the current target state.
A row collects **all** of its reasons, so one preview tells the operator
everything to fix. Reason messages never echo the offending value. The raw
row is returned only for quarantined rows, as JSON.

| Code | Trigger |
|------|---------|
| `FORBIDDEN_KEY` | `__proto__`, `prototype`, `constructor` as a key (JSON.parse creates these as own properties) |
| `UNKNOWN_FIELD` | Column not in the kind's schema. Schemas are strict so a renamed or extra column is caught |
| `INVALID_TYPE` | Object, array or boolean where a scalar was expected |
| `FORMULA_INJECTION` | Cell starts with `=`, `+`, `-`, `@`, TAB or CR. Plain signed numbers (`-5`) are allowed |
| `UNSAFE_CHARACTERS` | C0/C1 control characters, zero-width characters, BOM, bidi overrides. These make a value render differently from its bytes and defeat review of the preview |
| `FIELD_TOO_LONG` | Over 512 characters (256 for the KYC `reason`) |
| `MISSING_FIELD` / `INVALID_VALUE` / `INVALID_ADDRESS` | Schema validation |
| `MALFORMED_ROW` | CSV row with the wrong column count (it is **not** re-aligned), or a non-object JSON row |
| `DUPLICATE_IN_BATCH` | Two rows for the same record. **All** of them are quarantined, because which one should win is the operator's decision |
| `REQUIRES_REVIEW` | Valid row that crosses a policy line (KYC: lifting a `rejected` status) |
| `STATE_DRIFT` | *At commit*: the record changed after preview. The row is not overwritten |
| `APPLY_FAILED` | *At commit*: the row failed to apply 3 times (`MAX_ROW_ATTEMPTS`) and is skipped on the next retry |

Some problems mean no row can be trusted, and those refuse the whole payload
with 400 (nothing is staged): an unterminated CSV quote (row boundaries after
it are unknowable), duplicate, empty or reserved header names, more than 32
columns, more than 5,000 rows, or more than 2 MiB.

To fix quarantined rows, correct them at the source and import them as a
**new** batch. Quarantined rows are never edited in place, so every applied
row traces back to a file someone reviewed.

> If you export `GET /:id/quarantine` to a spreadsheet, escape cells first.
> The raw values in it are exactly the ones that were flagged as formula
> injection.

## Import kind: `kyc_attestation`

| Column | Rules |
|--------|-------|
| `address` | Required. A valid Stellar ed25519 public key, which is also the record key |
| `status` | Required. `pending`, `verified`, `accredited`, `rejected` or `expired`. An import can never set `none` |
| `providerReference` | Required. `[A-Za-z0-9._:/-]{1,128}`. Links the row back to the KYC provider |
| `expiresAt` | Required for `verified`/`accredited`, not allowed otherwise. Epoch ms (13 digits) or ISO-8601 **with a timezone**. Must be in the future and no more than 5 years ahead |
| `reason` | Optional, ≤ 256 characters |

- **Writes** go through `KycService.transitionStatus` with `source: 'import'`.
  That invalidates the Redis eligibility cache, so the import takes effect
  immediately rather than after the 60 s cache TTL.
- **Reads** during preview go to `KycStoreService.get` directly, because
  `KycService.getRecord` creates a `pending` record on first lookup, and
  preview must not write.
- **Policy**: importing `verified`/`accredited` over a `rejected` record is
  `REQUIRES_REVIEW`. A rejection is only lifted through the provider flow.
- **Noop**: rows whose status and expiry already match are accepted with
  action `noop` and are not written.

## Traceability

Each applied row is recorded in three places:

1. **Batch trace** (`GET /:id`, `GET /trace?key=`): row index, source line,
   fingerprint, before, after, actor and time. This lives in memory.
2. **KYC audit log** (`$KYC_STORE_DIR/kyc-audit.log.jsonl`): the entry's
   `reason` is `import <batchId> row <n> sha256:<first 16 hex of fingerprint>`.
   This file is durable, and it is the record that survives a restart.
   Rollbacks are logged as `rollback of import <batchId> row <n>`.
3. **Audit chain** (`AuditService`, entity type `import_batch`): one
   hash-chained entry per status transition, carrying the `previewHash`, the
   source sha256 and the summary counts.

The row fingerprint is the sha256 of the canonical (key-sorted) normalized
row. The batch's `sourceSha256` is the sha256 of the exact submitted CSV text
or JSON. Together they let you prove which file produced a given KYC change.

## Edge cases and failure modes

| Situation | Behaviour |
|-----------|-----------|
| Record changes between preview and commit | Row quarantined `STATE_DRIFT`, not overwritten. Other rows proceed |
| Two operators commit the same batch at once | The status flips to `committing` before the first await. The second call gets 409 `INVALID_STATE` |
| Commit and rollback race | The same lock: rollback gets 409 while `committing` |
| The same file is imported twice | The second preview shows `duplicateOf`. Commit refuses with `DUPLICATE_IMPORT` unless `allowDuplicate` is set. Rolling back the first batch clears the marker |
| Row fails mid-batch (store/IO error) | The batch stops at that row and becomes `partially_committed` with `lastError`. Rows after it are untouched. See retry |
| Write reached the store, then a later step threw (e.g. Redis) | On retry the current state already equals the expected `after`. The row is traced as applied and **not** written again |
| A row keeps failing | After 3 attempts it is quarantined `APPLY_FAILED` and the retry continues past it |
| Preview left too long | After 30 min commit gets 410. Re-submit so the operator reviews current state |
| `expiresAt` in the past or as a bare date | Quarantined. Bare dates are rejected because they would be read in the server's timezone |
| Excel exported a UTF-8 BOM | Stripped from the start of the file. A BOM anywhere else is `UNSAFE_CHARACTERS` |
| Process restarts | In-memory batches and traces are lost (see recovery). KYC writes and their audit lines are durable |
| 200 batches awaiting action | New previews get 503 `CAPACITY`. Only terminal batches (`committed`, `rolled_back`, `discarded`, `expired`) are ever evicted, oldest first. A batch that still needs retry or rollback is never dropped |

## Retry

`POST /:id/commit` with the same `previewHash` resumes a
`partially_committed` batch. Applied rows are skipped (the trace is the
source of truth). The failed row is retried, and every remaining row is
re-checked for drift. Retry is safe to repeat: it is idempotent per row.

1. Read `lastError` and fix the cause (disk, Redis, provider lock).
2. Retry. If the same row fails 3 times, it is quarantined and the batch
   finishes. Import that row separately once it is understood.
3. If the cause can't be fixed, roll back instead. Rollback works on
   `partially_committed` batches and undoes only the applied part.

## Rollback

`POST /:id/rollback` walks the trace newest-first. For each row:

- If the current state equals the row's **before** state, it was already
  restored and is marked rolled back with no write.
- If the current state equals the row's **after** state, the row is
  reverted, then re-read to verify.
- If the current state is **anything else**, someone changed the record
  after the import. That is a `conflict`. The record is left alone, and the
  batch ends `rollback_incomplete`.

| Conflict kind | Blocks? | Meaning / action |
|---------------|---------|------------------|
| `conflict` | yes | Record changed after the import. Decide manually which state is correct, set it through the normal KYC admin flow, then re-run rollback. It succeeds once the record is back at the import's `after`, or it skips the row once the record is at `before` |
| `error` | yes | Revert threw. Fix the cause and re-run rollback |
| `residual` | no | Reverted, but the store could not restore every field. See below |

Known residual: `KycStoreService` keeps the existing `expiresAt` when a
transition supplies none. So it cannot clear an expiry that the import set
on a record that previously had none. The status is restored correctly. The
leftover expiry only matters if the record is later moved to an eligible
status without an explicit expiry. The rollback result lists each such row.

The KYC store has no deletes. Rolling back a `create` therefore moves the
record to `none`, which no eligibility check accepts. The import sink reads
`none` as "no record", so re-importing that address later is a `create` again.

Rollback stays available while `IMPORT_PIPELINE=off`.

## Operations

| Variable | Effect |
|----------|--------|
| `IMPORT_PIPELINE=off` | Kill switch: commit and retry return 503. Preview, reads, discard and rollback still work, so a bad import can always be undone |

### Recovery after a restart

Batches are held in memory, bounded like the in-memory audit chain until
durable storage lands. After a restart, the batch ids and their traces are
gone, but every applied KYC row is still in the KYC audit log. To undo an
import from before the restart:

1. Find its writes. The `KycStoreService.listAudit` API only scans the
   **last `limit × 10` bytes** of the log, so it can miss older entries. Read
   the file directly instead:
   `grep '"reason":"import <batchId> ' $KYC_STORE_DIR/kyc-audit.log.jsonl`
2. For each line, `fromStatus` is the status before the import. A newly
   created record shows `pending` here: if this is the address's first audit
   line, the record did not exist before. The line's `expiresAt` is the
   *new* expiry. The previous expiry is on the address's preceding audit line.
   Check that the record's current status still equals the entry's
   `toStatus`. If it doesn't, it was changed later: treat it as a conflict,
   as above.
3. Restore each one through the KYC admin flow, with a reason referencing the
   batch id.

A file that was only previewed needs nothing: previews never write.

### Rolling back this feature

The pipeline adds new routes and a new module only. It changes no existing
schema, route or response. `KycStatusSource` already included `'import'`.
To disable the pipeline, set `IMPORT_PIPELINE=off`. To remove it, drop
`ImportsModule` from `app.module.ts`. KYC records written by imports are
ordinary records with `source: 'import'`, and nothing else depends on the
module.

The older `BulkImportService` (`api/src/common/services/bulk-import.service.ts`)
is an unused dry-run stub. It is left unchanged for compatibility. New import
kinds should implement `ImportSink` (`api/src/imports/import.interface.ts`)
and register with `ImportPipelineService.registerSink` instead.

## Adding an import kind

Implement `ImportSink`:

- `fields`: the exact column set.
- `normalize`: schema validation that returns quarantine reasons.
- `keyOf`: the record's natural key.
- `inspect`: **must not write**. It returns the before/after state, the
  action, and any policy `reviewReasons`.
- `apply` / `current` / `revert`: `current` must return the same shape as
  `after`, because drift detection and rollback compare them by canonical
  JSON.

Do not add sinks for data whose source of truth is on-chain, such as bond
holder balances. Reconcile those from the chain instead.
