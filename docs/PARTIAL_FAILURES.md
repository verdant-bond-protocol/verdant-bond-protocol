# Partial failure dashboard (#266)

Maintainer view of operations stuck between internal state and external
systems (Stellar settlement, oracle ingestion, bond issuance, marketplace
orders): everything half-completed is recorded, grouped and linked to the
actions that can resolve it.

## Model

- **`PartialFailure`** — `operationType`, optional `externalRef` (opaque
  external reference: tx hash, report id, cursor), `message`, `severity`
  (`info|warning|critical`), `retryable`, `status`
  (`open|retrying|resolved`), `retryCount`, a `metadata` payload, and a
  `lifecycle` (see below).
- **Status flow**: `open → retrying → resolved`. Status describes the *work*.
  Visibility is not a status — see **Archive lifecycle** below.
- **Staleness**: an open failure older than `staleAfterMs` (default 24 h) is
  flagged `stale: true` on the board; resolved failures never count as stale.
- **Secret hygiene**: `record()` deep-scrubs the metadata — any key matching
  `secret|password|passphrase|private_key|privateKey|seed|mnemonic|token|apikey` is
  replaced with `[redacted]` before storage, so the dashboard can be shared
  without leaking credentials.

## Archive lifecycle

A failure leaves the board by being **archived**, not by acquiring an
`ignored` status that only the board remembers to filter. The lifecycle
(`api/src/common/lifecycle/record-lifecycle.ts`) is shared with every other
archivable record in the API and enforces:

- an **actor** and a **reason** are both mandatory — `archiveReason` records
  *why* a record was withdrawn, not just *that* it was;
- the transition is **reversible** through `restore`, which keeps the archive
  in the record's `history` so an archived-then-restored record is visibly
  different from one that never was;
- **double transitions throw** rather than silently overwriting the original
  attribution;
- archived records **refuse work actions** — `resolve` and `markRetried` return
  `409` until the record is restored, rather than mutating something hidden.

Archived failures are never rendered as board rows, but they are **counted**:
the board reports `archived` per group and overall, and the trend export
carries the same figure in its own column. The export is therefore a
description of the same population the board shows, not a superset of it.

## Dashboard

`GET /api/v1/operations/failures` (admin-only) returns:

- `groups` — one per `operationType`, sorted by the oldest failure's age, each
  with `byStatus`, `bySeverity`, `archived`, `retryable` counts, the oldest
  age, and the individual failures.
- Every row carries `ageMs`, `stale` and **links**: `retry` (POST endpoint
  when the failure is retryable), `inspect` (GET the failure), and
  `remediationDoc` (per-operation runbook).

## API (admin-only)

| Route | Behaviour |
| --- | --- |
| `GET /api/v1/operations/failures` | grouped dashboard view (`?includeArchived=true` to opt in) |
| `GET /api/v1/operations/failures/:id` | inspect one failure |
| `POST /api/v1/operations/failures` | record a partial failure |
| `POST …/:id/retry` | mark a retry attempt (bumps counter, `retrying`) |
| `POST …/:id/resolve` | resolve with a note |
| `POST …/:id/archive` | archive with a **required** reason; attributes the operator |
| `POST …/:id/restore` | reverse an archive |
| `GET …/trends` | export bucketed operational metrics as JSON or CSV |
| `GET …/dependencies` | build a cross-resource dependency graph for impact analysis |
| `GET …/rejections/:code/explanation` | return a user-facing rejected-operation explanation |

The dashboard route accepts maintainer queue filters:
`operationType`, `status`, `severity`, `retryable`, `externalRef`, `text`,
`staleOnly`, `minRetryCount`, `createdAfter`, `createdBefore`, and
`includeArchived`.
`GET …/trends` accepts `bucketMs`, `from`, `to`, and `format=json|csv`.
Dependency graph edges are derived from metadata `dependsOn` entries; pass
`rootId` to focus impact analysis on one operation, external reference, or
resource id.

## Design decisions & tradeoffs

- **In-memory store**, consistent with the recovery/impersonation modules:
  the dashboard reflects the live process. Durable history can back the same
  interface later.
- **Grouping server-side** keeps the board a single request for operators;
  advanced filters cover operation type, status, severity, retryability,
  external reference, text, retry count, staleness and creation window.
- **Dependency graph** uses explicit `metadata.dependsOn` references rather
  than guessing relationships from free-form text. This keeps impact analysis
  deterministic and makes producers responsible for recording resource links.
- **Trend exports** are bucketed from recorded failure timestamps, so the
  same data can feed dashboards, incident reviews and financial/operational
  metric exports without exposing per-user secrets.
- **Retry marking is bookkeeping only**: `markRetried` records the attempt so
  repeat submissions are visible; the actual re-drive stays with the owning
  worker/integration, which is the component that knows the operation.
- **Archiving is a lifecycle, not a status.** A single shared
  `RecordLifecycle` decides visibility, so the board, the listing, the
  dependency graph and the export cannot disagree about what a failure's
  visibility is — the previous split, where the board filtered `ignored` but
  the CSV still emitted it, is exactly what this replaces.
- Archived failures are kept, not deleted, so the decision is auditable via
  `GET …/:id` and reversible via `POST …/:id/restore`.

## Tests

`api/src/failures/partial-failure.service.spec.ts` covers secret scrubbing,
grouping with severity/retryability counts, staleness vs. resolution, the
retry counter flow, resolution, the archive/restore lifecycle (including
refused transitions and board/export parity), advanced filters, dependency
graphs, rejection explanations and trend exports.
`api/src/common/lifecycle/record-lifecycle.spec.ts` covers the shared rules
themselves.

```bash
pnpm --filter api test -- partial-failure record-lifecycle
```
