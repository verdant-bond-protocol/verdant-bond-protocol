# Tamper-Evident Event Ledger

A single, chronological, hash-chained record of every **privileged** and
**financial** event in the API: one sequence across the whole protocol, so the
ledger proves both *what* happened and *in what order* across entities (for
example, that a KYC override came before the coupon distribution it enabled).

Implementation: `api/src/ledger/`. Tests: `api/src/ledger/*.spec.ts`, plus
ledger coverage blocks in `impersonation.service.spec.ts` and
`order-state.service.spec.ts`. Offline verifier:
`api/scripts/verify-ledger-export.ts`.

## How it relates to the audit chain

| | Audit chain (`api/src/audit`, #260) | Event ledger (this doc) |
|---|---|---|
| Chain scope | one chain **per entity** | **one global chain** |
| Ordering guarantee | within an entity | across all entities |
| Content | before/after snapshots of any mutation (incl. every HTTP mutation via `AuditInterceptor`) | registered privileged/financial event types only |
| Writers | any authenticated principal (`POST /audit/record`) | server-side services only; **no HTTP append route** |
| Full-rewrite protection | none (hashes can be recomputed) | HMAC checkpoints |
| Export | redacted evidence bundles | verifiable NDJSON + manifest |

Nothing in the audit module changed; both run side by side.

## What is recorded

Event types are a closed registry (`LEDGER_EVENT_TYPES` in `ledger.types.ts`).
Each type is bound to exactly one category, so a financial event cannot be
filed as privileged, and a typo cannot open a new, unmonitored stream.

| Category | Types |
|---|---|
| privileged | `role.granted`, `role.revoked`, `admin.intent.executed`, `impersonation.started`, `impersonation.operation_allowed`, `impersonation.operation_denied`, `impersonation.ended`, `impersonation.expired`, `impersonation.revoked`, `kyc.override`, `oracle.override`, `config.changed`, `ledger.exported` |
| financial | `bond.issued`, `subscription.allocated`, `coupon.distributed`, `carbon_credit.retired`, `settlement.completed`, `settlement.rolled_back`, `redemption.processed`, `fee.collected` |

Currently wired emitters:

- `ImpersonationService` — every session event (`impersonation.*`). The
  service's own audit list is capped at 5,000 and evicts; the ledger does not.
- `OrderStateService.markSettled` / `rollbackAfterSettlementFailure` —
  `settlement.completed` / `settlement.rolled_back`, only after the state
  transition succeeded.
- `EventLedgerService.export` — `ledger.exported` (who exported which range).

The remaining types are registered so that issuance, coupon, credit-retirement,
KYC and oracle-override flows can emit them with one call:

```ts
constructor(@Optional() private readonly ledger?: EventLedgerService) {}
// ...after the action succeeded:
await this.ledger?.appendSafe({
  type: 'coupon.distributed',
  actor: 'system:coupon-engine',
  subjectType: 'bond',
  subjectId: bondId,
  payload: { period, totalPaid: total.toString(), holders: n },
  correlationId,
});
```

`LedgerModule` is `@Global`, so no module imports change. Injection is
`@Optional()`, so existing unit tests that build a service without the ledger
keep passing unchanged.

### Adding an event type

Add it to `LEDGER_EVENT_TYPES` with its category. Never rename or re-categorise
an existing type: stored events would then fail verification with
`unknown event type` / `category mismatch`.

## Event format and hashing

```jsonc
{
  "schemaVersion": 1,
  "sequence": 42,                       // global, contiguous from 1
  "eventId": "uuid",
  "category": "financial",              // derived from type, never caller-supplied
  "type": "settlement.completed",
  "actor": "system:order-state",
  "subjectType": "marketplace-order",
  "subjectId": "7",
  "payload": { "filledAmount": "100", "version": 4 },
  "correlationId": null,                // request correlation id (#398) when known
  "occurredAt": "2026-10-16T15:00:00.000Z",  // business time
  "recordedAt": "2026-10-16T15:00:00.120Z",  // ledger time, never decreases
  "previousHash": "<hash of 41, or 64 zeros for sequence 1>",
  "hash": "<sha256 hex>"
}
```

`hash = SHA-256("verdant-ledger:event:v1\n" + canonicalJSON(event without hash))`,
where canonical JSON sorts object keys recursively (`stableStringify` in
`audit.canonical.ts`) and keeps array order. The prefix provides domain
separation from audit-chain hashes. This is the full specification: a third
party can re-implement verification without this codebase.

Payloads must be plain JSON. `Date`s, class instances, `NaN`/`Infinity`,
`undefined`, functions and bigints are rejected, because canonical JSON would
silently change them (a `Date` serialises as `{}`) and the stored record would
no longer mean what the caller intended. Amounts should be strings. Keys that
name secrets (`password`, `secret`, `token`, `accessToken`, `privateKey`,
`seed`, `mnemonic`, `apiKey`, `ssn`, ... after removing `_`/`-` and ignoring
case) are rejected outright, since an append-only ledger cannot be redacted
later. `tokenAmount`, `tokenId` and similar are allowed. Payloads are capped at
16 KiB.

## What verification detects

`verifyLedgerEvents` (pure, in `ledger.chain.ts`) reports **every** failure, not
just the first, so the extent of damage is visible before recovery starts.

| Tampering | Detected by | Failure reason |
|---|---|---|
| Edited field (payload, actor, timestamps, ids) | content hash | `content hash mismatch` |
| Dropped, reordered, inserted, or replayed event | sequence + link + id | `sequence break`, `previous hash mismatch`, `duplicate event id` |
| Event moved to the other category / unknown type (even with rehashing) | type registry | `category mismatch`, `unknown event type` |
| Back-dated ledger time (even with rehashing) | monotonic check | `recordedAt went backwards` |
| **Full rewrite** with every hash recomputed | HMAC checkpoint | `checkpoint does not match event` |
| Forged checkpoint | HMAC key | `checkpoint mac invalid` |
| **Truncated tail** | checkpoint past head, or a trusted head | `checkpoint beyond ledger head`, `head mismatch` |
| Edited/truncated export file | manifest | `export body digest mismatch`, `export manifest mismatch`, `head mismatch` |

Two limits are inherent to hash chains and are addressed operationally:

1. **Recomputed chains.** Anyone with write access to storage can recompute all
   hashes after an edit. Only checkpoints made with `LEDGER_CHECKPOINT_KEY`
   (which storage never sees) catch this, and only for events at or before the
   last checkpoint. Keep the key out of the database and its backups.
2. **Truncation after the last checkpoint.** Removing the newest events leaves a
   valid chain. `GET /ledger/verify` compares storage with the running
   process's own head, which catches truncation while the process is up; across
   restarts, compare against a head you recorded externally (a previous
   export's `headHash`, or `--expected-head` on the CLI). Publishing the head
   periodically (e.g. in a ticketing system or as a Stellar memo) narrows this
   window to the publishing interval.

## API

All routes are `JwtAuthGuard` + `AdminGuard` and read-only apart from creating
a checkpoint.

| Route | Purpose |
|---|---|
| `GET /api/v1/ledger/status` | head sequence/hash, sealed state, `appendFailures`, checkpointing, last checkpoint |
| `GET /api/v1/ledger/events?fromSequence&limit&category&type&subjectType&subjectId` | read events (limit ≤ 1000) |
| `GET /api/v1/ledger/verify` | re-read storage and verify it, including against this process's head |
| `GET /api/v1/ledger/export?fromSequence&toSequence` | `{ manifest, ndjson }`, at most 10,000 events per call |
| `POST /api/v1/ledger/checkpoints` | checkpoint the current head now (idempotent per sequence) |

## Export and offline verification

An export is the NDJSON body (one canonical event per line) plus a manifest:
`fromSequence`, `toSequence`, `count`, `anchorHash` (the `previousHash` of the
first exported event, which is genesis for a full export), `headHash`,
`bodySha256`, the checkpoints in range, and who exported it and when. Partial
exports verify on their own from `anchorHash`; consecutive pages chain
together because each page's `anchorHash` equals the previous page's `headHash`.

```bash
curl -H "Authorization: Bearer $ADMIN_JWT" \
  "$API/api/v1/ledger/export?fromSequence=1&toSequence=10000" > export.json

cd api
LEDGER_CHECKPOINT_KEY=... npm run ledger:verify-export -- --file=export.json
LEDGER_CHECKPOINT_KEY=... npm run ledger:verify-export -- --file=export.json --expected-head=<trusted hash>
```

The verifier exits 0 when the export verifies, 1 on any failure and 2 on usage
errors. Without the key it still checks the chain and digests, and warns that
checkpoint MACs were not verified. Every export is itself ledgered as
`ledger.exported`, so access to the ledger leaves a trail.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LEDGER_STORE` | in-memory | `postgres` for durable storage (uses `DATABASE_URL`). In-memory is for development and tests only. |
| `LEDGER_CHECKPOINT_KEY` | unset | HMAC key, at least 32 chars. Unset or shorter disables checkpoints (`status.checkpointing = "disabled"`). |
| `LEDGER_CHECKPOINT_KEY_ID` | `v1` | Id stored in each checkpoint, used to select the key during verification. |
| `LEDGER_CHECKPOINT_RETIRED_KEYS` | unset | `id:key,id:key`: old keys still accepted for verification after rotation. |
| `LEDGER_CHECKPOINT_LOST_KEY_IDS` | unset | Comma-separated key ids an operator declared lost (see failure modes). Their checkpoints are matched to events, but their MACs are not checked. |
| `LEDGER_CHECKPOINT_INTERVAL` | `100` | Automatic checkpoint every N events. |

### Postgres storage

`PostgresLedgerStore` creates `ledger_events` and `ledger_checkpoints` with
`IF NOT EXISTS` on startup, the same approach as `AuditDurableStore` while the
repo has no migration tooling (#263). Each event is stored as its exact
canonical JSON in a `TEXT` column (not `JSONB`, which would re-normalise the
bytes that were hashed); the other columns exist for querying only and are
never trusted by verification. Triggers reject `UPDATE`, `DELETE` and
`TRUNCATE` on both tables, and `sequence` is the primary key, so a second writer
fails instead of forking the chain. Grant the API role `INSERT`/`SELECT` only.

## Runtime behaviour and failure modes

| Situation | Behaviour |
|---|---|
| Concurrent appends | Serialised through one promise queue; sequences follow call order, with no gaps. |
| Store write fails | The head does not advance and `append` rejects (`503`). The next operation re-reads the store first, because the write may have committed before the error (timeout after commit). |
| Two API replicas both writing | The primary key rejects the losing insert. The loser re-reads the store and continues on top of the winner, so the chain never forks. Under sustained contention appends fail more often; run a single ledger writer per database (see below). |
| Wall clock steps backwards (NTP, VM migration) | `recordedAt` is clamped to the previous event's value; `occurredAt` keeps the business time. |
| Invalid event (unknown type, bad payload, empty actor) | Rejected with `400`; no sequence is consumed. |
| Hook in a business flow fails | Hooks use `appendSafe`, which never rejects, so ledger problems cannot change access decisions or settlement results. Each failure is logged and counted in `status.appendFailures`. **Alert on a non-zero value**: it means an event is missing from the ledger. |
| Stored chain fails verification at startup | The ledger **seals**: appends and checkpoints are refused (`503`, `appendFailures` grows) so nothing new is chained onto a corrupted history. Reads, `verify` and export keep working so evidence can be preserved. `status.sealedReason` names the first failing sequence. |
| Checkpoint write fails | The event stays committed; the miss is logged, and the next checkpoint covers the gap. |
| In-memory capacity (100,000 events) reached | Appends refused with `503`; nothing is evicted, since eviction would rewrite history. The service keeps the whole ledger in memory and loads it on startup, so plan archival (export, then start a new ledger whose first event records the archived head) before reaching this. |
| Checkpoint key lost | Startup verification fails with `checkpoint mac invalid` and the ledger seals. Configure a new key and set `LEDGER_CHECKPOINT_LOST_KEY_IDS=<old id>`: checkpoints under that id are then still matched against their events, but their MACs are no longer checked. That means events before the next checkpoint under the new key lose full-rewrite protection, so record the acknowledgement in the incident log. |

## Rollback and recovery

**Rolling back this feature.** Remove `LedgerModule` from `app.module.ts` (and
optionally the two `@Optional()` hooks). Every hook is `ledger?.appendSafe(...)`,
so the services work unchanged without the provider. The Postgres tables are
left in place; nothing else reads them. Re-enabling later resumes the existing
chain. Do not drop the tables: they are the evidence.

**Rotating the checkpoint key.** Set the new key with a new
`LEDGER_CHECKPOINT_KEY_ID`, move the old one to `LEDGER_CHECKPOINT_RETIRED_KEYS`
and restart. If you forget the retired key, startup verification fails with
`checkpoint mac invalid` and the ledger seals; add the retired key and restart.
After restarting, call `POST /ledger/checkpoints` once so the current head
is covered by the new key.

**Recovering a sealed ledger.** Do not edit rows to make verification pass:
the rows are the evidence of what happened.

1. Read `GET /ledger/status` and `GET /ledger/verify` to find every failing
   sequence and reason.
2. Preserve evidence: export the full ledger (exports still work while sealed)
   and snapshot the database.
3. Identify the last good sequence: the highest sequence below the first
   failure that is covered by a valid checkpoint, or that matches a head
   recorded externally.
4. Restore `ledger_events` and `ledger_checkpoints` from the most recent backup
   whose chain verifies up to that point. Verify the backup offline first
   (export it from a scratch instance, or run `verifyLedgerEvents` on a dump)
   before putting it in place. Restoring requires temporarily disabling the
   append-only triggers as a superuser; re-enable them straight away, and
   record the change in your incident log.
5. Restart the API. Startup verification must pass and the ledger must report
   `sealed: false`.
6. Events between the restored head and the incident are lost from the ledger
   (the business systems still hold them). Re-emit them from their source
   records with `occurredAt` set to the original time. They get new sequences
   and a later `recordedAt`, so the gap stays visible. Attach the incident
   reference in the payload.
7. Treat an unexplained full-rewrite detection (`checkpoint does not match
   event`) as a security incident: someone had write access to storage. Follow
   `SECURITY.md` before restoring anything.

**Multi-replica deployments.** The ledger keeps its head in process memory.
With several API replicas pointed at one database, a replica only sees other
replicas' events after it next re-reads the store (after a write conflict or a
restart). Until then its reads are stale, and its `verify` compares storage
against its own lagging head, which produces `head mismatch` reports. Run the ledger in one
writer process, or route ledger appends through the job queue to a single
worker, until a store-side head lock exists.

## Compatibility

- No existing route, DTO, schema or response changed. The ledger only adds the
  `/api/v1/ledger/*` routes, new tables, and new optional environment
  variables.
- `ImpersonationService` and `OrderStateService` gained an optional
  constructor parameter. Existing `new X(redis)` calls and Nest wiring work
  unchanged.
- `schemaVersion` is part of every hash. A future format change must bump it,
  and the verifier must keep supporting version 1 for existing events. It must
  not rehash old events.
