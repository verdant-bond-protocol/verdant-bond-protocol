# Signed Receipts for Compliance and Governance Actions (#632)

Every privileged compliance or governance mutation now returns an
**Ed25519-signed receipt** bound to an entry in the hash-chained audit trail.
An auditor or regulator can later prove three things from the receipt: who
performed the action, what changed, and that the record has not been altered.

This builds on the generic audit receipts from #260 (`AuditReceiptService`,
`api/src/audit/audit.receipt.ts`). The receipt wire format and the
`AuditRecord` shape are unchanged.

## Receipted actions

| Endpoint (admin only) | Action | Audit entity |
|---|---|---|
| `POST /api/v1/compliance/ruleset/update` | `governance.ruleset.update` | `compliance-ruleset/<JURISDICTION>` |
| `POST /api/v1/compliance/sanctions/refresh` | `compliance.sanctions.refresh` | `compliance-sanctions/sanctions-list` |
| `POST /api/v1/compliance/eligibility/flush` | `compliance.eligibility.flush` | `compliance-eligibility/all` |
| `POST /api/v1/compliance/eligibility/invalidate/:address` | `compliance.eligibility.invalidate` | `compliance-eligibility/<address>` |

The catalog is closed (`GOVERNANCE_RECEIPT_ACTIONS`). Verification rejects
any receipt for another action with `not_a_governance_receipt`, so an
ordinary audit receipt cannot be passed off as proof of a governance
decision.

## Response shape (additive)

Each endpoint keeps its original response and adds `signedReceipt`:

```json
{
  "version": "2026.2", "auditHash": "…",
  "signedReceipt": {
    "receipt": { "version": 1, "recordId": "…", "hash": "…", "signature": "…",
                 "signerPublicKey": "-----BEGIN PUBLIC KEY-----…", "action": "governance.ruleset.update",
                 "actor": "G…", "entityType": "compliance-ruleset", "entityId": "US" },
    "idempotencyKey": "rule-1",
    "replayed": false,
    "recordedAt": "2026-11-22T…"
  }
}
```

The audit entry records a non-sensitive `before` and `after` summary, such as
ruleset version and hash, or entry counts. For sanctions refreshes it stores a
**SHA-256 digest** of the submitted lists, never the addresses themselves.

## Verification

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /api/v1/compliance/receipts/public-key` | public | SPKI PEM for offline verification |
| `POST /api/v1/compliance/receipts/verify` `{ receipt }` | admin | Checks the receipt against the live audit chain |

Verification returns `{ ok: true }`, or `{ ok: false, reason }` where `reason` is one of:
- `not_a_governance_receipt`
- `record_not_found`
- `record_mismatch` (the receipt was tampered with)
- `untrusted_signer`
- `signature_mismatch`
- `unsupported_version`
- `malformed_receipt`

## Paths and guarantees

### Normal path
1. Authorization is checked first. The actor must be authenticated and hold
   the `admin` role, which `AdminGuard` establishes. Auditors can verify
   receipts but cannot perform actions.
2. The mutation runs.
3. An audit entry is written and signed, and the receipt is returned.

### Retry path: `Idempotency-Key` header
Keys are scoped per *actor + action*. If no key is sent, one is generated and
returned in `signedReceipt.idempotencyKey`.

- **Same key and same payload after success:** the stored result and receipt
  are replayed (`replayed: true`). The action does not run again and no second
  audit entry is written.
- **Same key with a different payload:** `409`.
- **Same key while the first request is still running:** `409 … already in progress`.

### Failure path
If the mutation throws, **no receipt is issued**, nothing is audited and the
key is released, so the same key can be retried.

### Recovery: the action applied but the receipt failed
This happens if the audit write is rejected after the mutation succeeded, for
example because the audit store is at capacity.

1. The API returns `503 RECEIPT_PENDING` (`retryable: true`) with
   `context.idempotencyKey` and `context.actionApplied: true`.
2. The applied result is parked as `pending_receipt`. Pending entries are
   never evicted.
3. Retrying with the same key **issues the receipt without re-running the
   mutation**. A governance change is never applied twice in order to get a
   receipt.

### Key rotation and rollback
- New receipts are signed with `AUDIT_RECEIPT_SIGNING_KEY`. Without it, an
  ephemeral key is used and a warning is logged; see #260.
- After rotating, list the old public keys in
  `AUDIT_RECEIPT_PREVIOUS_PUBLIC_KEYS` (a JSON array of PEMs) so earlier
  receipts keep verifying. A malformed list is ignored, never trusted.
- **Rollback:** receipts are additive. Removing `GovernanceReceiptService`
  from `ComplianceModule` restores the previous responses exactly; the
  controller treats the service as optional.

## Limitations

- The idempotency ledger is in-memory per instance: it holds 1,000 completed
  entries with a 24 h TTL, and pending entries are pinned. In a multi-instance
  deployment, route an `Idempotency-Key` to the same instance, or move the
  ledger to Redis. This matches the other in-memory stores in the API.
- The audit store is also in-memory (#260), so receipts verify for the
  lifetime of that store.

## Related fix

`KycCommitmentService` (#469) signed its KYC receipts with
`crypto.sign('sha256', …)` on an Ed25519 key, which Node rejects
("invalid digest"), so no KYC receipt could ever be issued. It now uses the
required `null` digest. The bug was hidden because that spec, and the
compliance controller spec, failed to compile on `main`.

## Tests

```bash
cd api && npx jest src/compliance/services/governance-receipt.service.spec.ts
```
