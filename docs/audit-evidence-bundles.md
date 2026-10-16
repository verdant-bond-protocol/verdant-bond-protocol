# Privacy-Preserving Audit Evidence Bundles (#351)

Support and compliance investigations need to prove *what happened* to a bond,
KYC case or order without handing staff the investor's PII or any secret.

```
GET /api/v1/audit/evidence/:entityType/:entityId?caseId=SUP-1001
```

The endpoint is admin-only (`JwtAuthGuard` + `AdminGuard`) and needs a
`caseId`. Each export is itself recorded in the audit chain under
`evidence-bundle/<caseId>`, with the bundle id, digest and chain head, so
access to evidence leaves a trail.

Implementation: `api/src/audit/evidence-bundle.ts`. Tests:
`api/src/audit/evidence-bundle.spec.ts`.

## What is kept, digested or dropped

| Class | Examples | In the bundle |
|-------|----------|---------------|
| Structural | `recordId`, `sequence`, `recordedAt`, `hash`, `previousHash`, `action`, statuses, amounts, rates, contract ids (`C…`) | verbatim |
| Secrets | Stellar seeds (`S…`), JWTs, `*password*`, `*secret*`, `api_key`, access/refresh/session tokens, `seed`, `mnemonic` | `{ "redacted": "secret" }` (no digest, so it can never be confirmed) |
| PII | emails (by key or value), names, phone, DOB, passport, national/tax id, IBAN, postal address, `document*`, IP address | `{ "redacted": "pii", "digest": … }` |
| Wallets | Stellar accounts (`G…`) anywhere in a value | `{ "redacted": "account", "digest": … }` |
| Free text | `reason`, `notes`, `comment`, `description`, `message`, `memo` | `{ "redacted": "free-text", "digest": … }` |
| Actor | who performed each action | `{ "redacted": "actor", "digest": … }` |

`redactions[]` lists the path and the rule for each removed value, but never
the value itself.

**Digests.** A digest is `HMAC-SHA256(AUDIT_EVIDENCE_PEPPER, canonical JSON(value))`.
The same wallet gets the same digest in every field and every bundle, so an
investigator can correlate ("the actor of #1 is the wallet in #2"). The pepper
never leaves the server, so a bundle cannot be brute-forced back to an email or
wallet. A pepper holder can still confirm a candidate value with
`matchesRedacted`.

## Verifying a bundle

`verifyEvidenceBundle(bundle)` needs no secrets. It checks:

1. the `digest` (sha256 over the canonical bundle), which detects any edit
   after export;
2. sequences are contiguous from 1, and each `previousHash` equals the previous
   record's `hash`;
3. timestamps never go backwards, and `chainHead` is the last record's hash;
4. `sourceVerification.ok`: the server re-hashed the *unredacted* records
   against their stored hashes at export time (`AuditService.verifyEntity`).

**Ceiling.** The entry hashes cover unredacted content, so a bundle reader
cannot re-hash entries themselves. Content integrity rests on the
export-time verification plus the sealed digest. To make the digest
authoritative, store it in the case system when the bundle is attached.

## Configuration

| Variable | Required | Notes |
|----------|----------|-------|
| `AUDIT_EVIDENCE_PEPPER` | in production (config contract) | ≥32 chars; the endpoint returns 503 without it |
| `AUDIT_EVIDENCE_PEPPER_ID` | no (default `v1`) | stamped into each bundle as `pepperId` |

## Operational edge cases

- **Pepper rotation.** Set a new pepper and bump `AUDIT_EVIDENCE_PEPPER_ID`.
  Old bundles keep their id. Digests from different peppers are not
  comparable, so keep retired peppers in the secret store if old bundles still
  need confirming.
- **Pepper leak.** Digests of low-entropy PII (emails, wallets) become
  guessable. Rotate immediately and treat outstanding bundles as containing
  pseudonymous, not anonymous, data.
- **Tampered source chain.** The bundle still exports, with
  `sourceVerification.ok=false` and the failure indices, and offline
  verification fails. Escalate as an integrity incident.
- **New PII field names.** Redaction is driven by key and value rules. Before
  a new domain field holding personal data ships, extend `PII_KEY` and add a
  case to the spec's leak test.
- **Rollback.** The endpoint and module are additive. Reverting removes the
  endpoint. Bundles already issued stay verifiable with the same code at any
  later version (`schemaVersion: 1`).
