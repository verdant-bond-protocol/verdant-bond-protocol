# Audit History (Issue #260)

Tamper-evident change history for critical domain records — records whose
mutations affect **ownership, money, permissions, or user access**.

## Why not just timestamps?

Mutable timestamps cannot distinguish "changed legitimately at 14:02" from
"changed illegitimately and the change was backdated." This module records, for
every critical mutation, a **before/after snapshot, the acting principal, the
stated reason, and a cryptographic link to the previous entry for that same
entity**. Altering a historical payload, dropping an entry, or reordering
entries all become detectable without any trust in who performed the check.

## Design

Each `AuditRecord` carries:

| Field | Meaning |
|---|---|
| `sequence` | Per-entity, starts at 1, increments by 1 — never reused |
| `previousHash` | Hash of the immediately preceding entry for the same entity (`null` for the first) |
| `hash` | SHA-256 over a canonical serialisation of the entry's content |
| `before` / `after` | Full payload snapshot, JSON-serialised |
| `actor`, `reason`, `recordedAt`, `action` | Who, why, what, when |

Hashing is over a **canonical** serialisation (object keys sorted recursively,
`stableStringify`), so two serialisations of one record always hash identically.
`recordId` (a random uuid) is deliberately excluded from the hash: it cannot be
reproduced on re-verification, whereas everything in the digest can.

## What each check detects

`AuditService.verifyEntity(entityType, entityId)` rebuilds every entry hash and
walks the chain, then reports the first failure per entry with its index:

| Tampering | Detection |
|---|---|
| Altered `before`/`after`/`actor`/`reason`/`recordedAt` | `content hash mismatch` |
| A *replaced* whole history set | `previous hash mismatch` at the rebuilt head, since the attacker cannot reconstruct matching hashes without knowing the chain head |
| Dropped entry | `sequence break` *and* `previous hash mismatch` |
| Reordered entries | `sequence break` on the first out-of-order step |
| First entry forged with `sequence != 1` | `first entry sequence must be 1` |

Reports include `failedIndex`, `expected`, and `actual`, so maintainers can
pinpoint the first mutated entry rather than just knowing "something is wrong."

## Retention and bounds

- In-memory chain: **10,000 total entries**, **5,000 per entity**. Beyond the
  per-entity cap the oldest entry is dropped (and counted in `totalExpired`);
  beyond the global cap new writes are **refused** and counted in
  `droppedWrites`. Both bounds are reported by `GET /audit/stats`.
- Durable store: `AuditDurableStore` appends every recorded entry to a
  `audit_history` Postgres table (`DATABASE_URL`, already provisioned). DDL is
  `CREATE TABLE IF NOT EXISTS` at module init — the repo has no migration
  tooling yet (that gap is issue #263). A `UNIQUE (entity_type, entity_id,
  sequence)` constraint makes sequence reuse impossible at the storage layer,
  so a dropped entry cannot be silently "filled in" later with the same
  sequence number.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/audit/record` | JWT | Record a mutation |
| `GET` | `/audit/verify/:entityType/:entityId` | Admin | Tamper check |
| `GET` | `/audit/history/:entityType/:entityId` | Admin | Full history dump |
| `GET` | `/audit/stats` | JWT | Bounded-memory counters |

Verification is read-only and rebuilds hashes from stored content, so it is
never itself a mutation. Verification and history reads are admin-gated because
a verifier readable by everyone doubles as an oracle for "does this entity have
a history", and steady-state history dumps are large.

## What is *not* covered

- **Determining *who* tampered from the chain alone.** The chain detects *that*
  an entry was altered, not which principal did it — `actor` is recorded as
  stated and is not itself a signature. For privileged actions, attribution is
  provided by the signed receipt layer below; the chain's own hash remains
  unkeyed by design.
- **Automatic repair.** A failed verification is reported, never auto-mutated.
  Recovery from confirmed tampering is a manual, maintainer decision.

## Usage

```ts
await audit.record({
  entityType: 'Bond',
  entityId: '42',
  action: 'transfer',
  actor: user.walletAddress,
  reason: 'secondary-market sale',
  before: { holder: 'GOLD...' },
  after: { holder: 'GNEW...' },
});

const report = await audit.verifyEntity('Bond', '42');
if (!report.ok) {
  // inspect report.failures[i].failedIndex / expected / actual
}
```

## Signed audit receipts for privileged actions

`AuditReceiptService` (in `api/src/audit/`) adds **non-repudiable, verifiable
receipts** on top of the unchanged hash chain. It is additive: `AuditRecord`,
`AuditWrite`, `AuditWriteResult`, the chain hash algorithm, and all existing
routes keep their current shapes.

- `recordPrivilegedAction(write, { actorRoles })` writes the audit entry and
  returns `{ record, receipt }`. Pass the roles from your auth guard; only
  `admin` and `auditor` may request a signed receipt. Omitting `actorRoles`
  preserves the internal-caller behaviour.
- `issue(record)` signs an existing entry; `verify(record, receipt, trusted?)`
  verifies it. By default only the current signing key is trusted; pass
  `trustedPublicKeys` to accept receipts from a rotated key.
- Receipts are Ed25519 signatures (domain separator `verdant-audit-receipt:v1\n`)
  over `stableStringify` of every authoritative audit field, plus binding
  fields (`recordId`, `hash`, `action`, `actor`, `entityType`, `entityId`) that
  prevent replaying one receipt for another entry.

**Configuration:** set `AUDIT_RECEIPT_SIGNING_KEY` to a PKCS#8 Ed25519 private
key. An invalid configured key fails closed at boot. If unset, an ephemeral
key is generated with a warning: receipts then verify only within that process
and **will not survive a restart**. Publish the corresponding SPKI public key
via `AuditReceiptService.publicKey` to verifiers.

| Path | Verified behaviour (`api/src/audit/audit.receipt.spec.ts`) |
|---|---|
| Normal | Issue and verify; configured key; chain still verifies after issuance. |
| Failure | Tampered payload → `signature_mismatch`; changed binding field → `record_mismatch`; forged signature; unsupported version; malformed signature; rejected audit write → `ServiceUnavailableException`; invalid configured key fails boot. |
| Retry / replay | Deterministic signatures (re-signing is idempotent); repeated verification; receipt cannot be replayed for a different record; key rotation via explicit trusted-key list. |
| Authorization | Non-privileged role → `ForbiddenException`; receipt from an untrusted key → `untrusted_signer`. |

**Edge cases and recovery:**
- Verification order is version → shape → binding fields → trusted key →
  signature, so the failure reason tells you which control fired.
- Ed25519 signatures are deterministic for a fixed key and message; a stable
  key means reissuing a receipt for the same record reproduces the same bytes.
- Key rotation: keep the old public key in `trustedPublicKeys` for the overlap
  window, then drop it. A compromised key requires reissuing affected receipts
  under a new key and treating old signatures as untrusted.
- There is no durability for the receipts themselves yet; the durable Postgres
  audit store is not wired into `AuditModule`. Export signed receipts alongside
  the evidence bundle if they must outlive a restart. Rolling back is a code
  revert of `audit.receipt.ts`, `audit-receipt.service.ts` and the module
  provider entry — no schema migration is involved.
