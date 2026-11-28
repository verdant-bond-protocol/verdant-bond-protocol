# Reproducible Bond Lifecycle Audit Bundle (#640)

This slice produces a single, deterministic, offline-verifiable bundle for one
bond's issuance-to-redemption lifecycle. It is additive: no contract, storage
key, database schema, or existing public response shape changes.

## Endpoint

```
GET /api/v1/audit/bond-lifecycle/:bondId?caseId=AUD-640&asOf=2026-11-22T00:00:00.000Z
```

- Guards: `JwtAuthGuard` plus `AdminGuard`. Non-admin callers receive 401/403
  before any bond state is read.
- `caseId` is required and binds the bundle to an audit/investigation case.
- `asOf` is required and must be an exact ISO-8601 UTC timestamp. Requiring the
  caller to supply it makes repeated exports byte-identical; without it a
  server-side clock would make the digest irreproducible.
- `AUDIT_EVIDENCE_PEPPER` (>= 32 chars) must be configured. The export returns
  503 otherwise, matching the evidence-bundle contract in
  `docs/audit-evidence-bundles.md`.
- The export itself is appended to the audit chain under
  `bond-lifecycle-bundle/<caseId>` with the bundle id, digest, `asOf`, and
  lifecycle chain head.

Implementation:

- Core (dependency-free, deterministic): `api/src/audit/bond-lifecycle-bundle-core.ts`
- API composition: `api/src/audit/bond-lifecycle-audit-bundle.service.ts`
- Controller/module: `api/src/audit/controllers/bond-lifecycle-audit.controller.ts`,
  `api/src/audit/bond-lifecycle-audit.module.ts`

## What goes into the bundle

The core receives normalized evidence; it never calls a network or reads a
clock. All values are strings or integers, and every monetary value is a
base-10 minor-unit string parsed with `BigInt` (never a float).

| Section | Contents |
|---------|----------|
| `sourceChain` | Entity key, chain head, and `AuditService.verifyEntity` result with failure indices/reasons only. |
| `rawExport` | SHA-256 of the canonical bond/events/holders/coupons/retirements snapshot, excluding the raw export's timestamped metadata, plus section counts. |
| `lifecycle.events` | Deterministically sorted, hash-chained events. Each event carries stage, path, outcome, dedupe key, actor digest, optional amount, and optional audit sequence/hash. |
| `stages` / `paths` | Coverage counts and event ids for all four stages and all four operational paths. Missing coverage is reported, not hidden. |
| `financialInvariants` | Six read-only checks described below. |
| `redactions` | Paths and rules only. Actor and exporter values are HMAC-SHA256 digests under `AUDIT_EVIDENCE_PEPPER`; raw emails, wallet ids, JWTs, and seeds are never placed in the bundle. |
| `bundleId` / `digest` | `blb-` + SHA-256 of `{bondId, caseId, asOf, chainHead, sourceChainHead}`; `digest` is SHA-256 over the canonical bundle body without `digest`. |

Serialization uses recursive key sorting (`canonicalize`/`stableStringify`), so
object key insertion order and event input order cannot change the digest.
Event ids are chained: each id hashes the normalized event plus its index and
previous event id, so dropping, reordering, or editing an event breaks the
chain.

## Operational paths

The four acceptance paths are explicit evidence classes, not prose:

- **Normal** — issued, holder register, coupon distribution, and retirement
  events derived from `BondsService.exportBond`.
- **Failure** — audit records whose action matches failure/validation rules,
  recorded with `outcome: rejected` or `observed`. An applied failure event
  fails invariant `INV-05`.
- **Retry** — audit records matching retry/reconciliation/idempotency rules.
  Applied retry events must have unique `dedupeKey` values (`INV-06`), which
  mirrors the on-chain nonce replay guard.
- **Authorization** — the admin-only export authorization event plus any audit
  records matching auth/admin/KYC/permission rules.

Stages are `issue`, `subscribe`, `coupon`, and `redeem`. A bundle is incomplete
if any stage or path has zero events; `verifyBondLifecycleBundle` reports
`missing lifecycle stage: ...` / `missing lifecycle path: ...` instead of
claiming full coverage.

## Financial invariants

| Id | Check |
|----|-------|
| `INV-01` | `totalSubscribed <= totalSupply` (supply ceiling). |
| `INV-02` | `sum(holderBalances) == totalSubscribed` (holder conservation). |
| `INV-03` | `sum(retirements) <= totalSupply` (redemption bound). |
| `INV-04` | `faceValue > 0`. |
| `INV-05` | No failure-path event is marked `applied`. |
| `INV-06` | No duplicate applied retry dedupe key (no double apply). |

The bundle is read-only. It does not issue, subscribe, distribute, transfer,
mature, or redeem anything; it observes state through the existing export and
audit services. Contract arithmetic and stable error codes are untouched.

## Verification

Automated unit tests: `api/src/audit/bond-lifecycle-bundle-core.spec.ts`
(`npm test` from `api/`).

Executable verification (no npm install, no external packages, Node >= 22.6):

```sh
node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-bond-lifecycle-audit-bundle.mjs
npm run verify:bond-lifecycle-audit-bundle --prefix api
node scripts/run-all-verifications.mjs
```

The script builds the same fixture twice with reversed event order, checks all
stages/paths and invariants, mutates a value/chain/source flag, and asserts
each tamper is detected. Offline verification of a received bundle uses:

```ts
import { verifyBondLifecycleBundle } from './api/src/audit/bond-lifecycle-bundle-core';
const { ok, problems } = verifyBondLifecycleBundle(receivedBundle);
```

No secret material is needed to verify a bundle.

## Edge cases and recovery

- **Tampered bundle** — digest or event-chain failure. Discard the file and
  re-export with the same `caseId` and `asOf`; the regenerated digest must match
  the digest pinned in the case system.
- **Failed source-chain verification** — the bundle still exports with
  `sourceChain.verification.ok=false`, and offline verification fails. Treat as
  an integrity incident; do not use the bundle as evidence until the chain is
  repaired and re-exported.
- **Incomplete path coverage** — verification reports the missing path. Check
  that the expected audit records exist and that action names match the
  classification rules; then re-export with the same `asOf`.
- **Big balances** — amounts beyond `Number.MAX_SAFE_INTEGER` stay strings and
  are compared as `bigint`. Invalid, negative, or over-64-digit values are
  rejected at the boundary.
- **Missing holders** — the holder index is point-in-time; if it is stale or
  truncated, `INV-02` fails. Reindex holders (`npm run reindex-holders`) and
  re-export. The bundle never mutates the index itself.
- **Partially processed redemption** — queued/partial redemptions are
  represented by retirement rows and audit events. There is no rollback of a
  settlement here; use `docs/partial-settlement-recovery.md`, then re-export.
- **Pepper rotation** — set a new `AUDIT_EVIDENCE_PEPPER` and bump its id in the
  secret store. Actor digests from different peppers are not comparable; keep
  retired peppers if old bundles need confirmation.
- **PII leaked through a new field** — extend the leak patterns in the core and
  add a fixture case before shipping that field.
- **Rollback** — this module is additive. Reverting the commit removes the
  endpoint and provider; no stored data is rewritten. Bundles already exported
  remain verifiable by code pinned to `schemaVersion: 1`.

## Migration plan

None required. There is no new on-chain state, no storage-key change, no
database migration, and no change to `BondsService.exportBond`, the regulator
export, or any existing response contract. The new route is a separate module
registered in `AppModule`; consumers that never call it are unaffected. A
future schema change must increment `BOND_LIFECYCLE_BUNDLE_SCHEMA_VERSION` and
keep verification support for version 1 bundles.
