# Partial failure dashboard (#266)

Maintainer view of operations stuck between internal state and external
systems (Stellar settlement, oracle ingestion, bond issuance, marketplace
orders): everything half-completed is recorded, grouped and linked to the
actions that can resolve it.

## Model

- **`PartialFailure`** — `operationType`, optional `externalRef` (opaque
  external reference: tx hash, report id, cursor), `message`, `severity`
  (`info|warning|critical`), `retryable`, `status`
  (`open|retrying|resolved|ignored`), `retryCount`, and a `metadata` payload.
- **Status flow**: `open → retrying → resolved` (remediation succeeded) or
  `open → ignored` (a maintainer decided to look the other way, with a
  recorded note). Ignored failures leave the board but stay queryable.
- **Staleness**: an open failure older than `staleAfterMs` (default 24 h) is
  flagged `stale: true` on the board; resolved failures never count as stale.
- **Secret hygiene**: `record()` deep-scrubs the metadata — any key matching
  `secret|password|private_key|privateKey|seed|mnemonic|token|apikey` is
  replaced with `[redacted]` before storage, so the dashboard can be shared
  without leaking credentials.

## Dashboard

`GET /api/v1/operations/failures` (admin-only) returns:

- `groups` — one per `operationType`, sorted by the oldest failure's age, each
  with `byStatus`, `bySeverity`, `retryable` counts, the oldest age, and the
  individual failures.
- Every row carries `ageMs`, `stale` and **links**: `retry` (POST endpoint
  when the failure is retryable), `inspect` (GET the failure), and
  `remediationDoc` (per-operation runbook).

## API (admin-only)

| Route | Behaviour |
| --- | --- |
| `GET /api/v1/operations/failures` | grouped dashboard view |
| `GET /api/v1/operations/failures/:id` | inspect one failure |
| `POST /api/v1/operations/failures` | record a partial failure |
| `POST …/:id/retry` | mark a retry attempt (bumps counter, `retrying`) |
| `POST …/:id/resolve` | resolve with a note |
| `POST …/:id/ignore` | manually ignore with a note |

## Design decisions & tradeoffs

- **In-memory store**, consistent with the recovery/impersonation modules:
  the dashboard reflects the live process. Durable history can back the same
  interface later.
- **Grouping server-side** keeps the board a single request for operators;
  filters (`operationType`, `status`, `retryable`) are available on `list`.
- **Retry marking is bookkeeping only**: `markRetried` records the attempt so
  repeat submissions are visible; the actual re-drive stays with the owning
  worker/integration, which is the component that knows the operation.
- Ignored failures are kept (not deleted) so the decision is auditable via
  `GET …/:id`.

## Tests

`api/src/failures/partial-failure.service.spec.ts` covers secret scrubbing,
grouping with severity/retryability counts, staleness vs. resolution, the
retry counter flow, resolution and manual ignore — the stale, retryable,
resolved and manually-ignored cases from the acceptance criteria.

```bash
pnpm --filter api test -- partial-failure
```
