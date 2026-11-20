# Maintainer Action Approval Flow & Signed Intent Receipts

High-impact maintainer actions (bond issuance, coupon distribution, sweeps,
maturity, holder reconciliation/reindexing, project approval/rejection, oracle
provider registration, incident acknowledgement/resolution) already require a
signed step-up **intent** ([runbook-admin-intent.md](runbook-admin-intent.md),
#115). This flow adds a server-countersigned **receipt** for every intent
decision so approvals can be reviewed after the action completes, fails, or
is refused.

Code: `api/src/intent-receipts/`, `api/src/common/guards/intent.guard.ts`,
`api/src/common/decorators/require-intent.decorator.ts`.

## Flow

```
maintainer signs intent ─▶ IntentGuard.verify
                              │
               ┌──────────────┴───────────────┐
            invalid                          valid
               │                               │
   receipt: rejected (terminal)     receipt: authorized ── nonce consumed
   401 / 409 returned               handler runs
                                               │
                              ┌────────────────┼──────────────────┐
                           returns           throws         process dies
                              │                │                  │
                  receipt: succeeded   receipt: failed     stays authorized
                  (resultDigest)       (client-safe error)  → `stale` after
                                                              INTENT_RECEIPT_STALE_MS
                                                              → reviewer reconciles
```

* **Explicit intent is mandatory.** `@RequireIntent` now also attaches
  `IntentReceiptInterceptor`, so a route cannot opt into intent checking
  without producing receipts.
* **Receipts are finalised before the response is sent.** When a client gets
  the HTTP response, `GET /admin/intent-receipts/:id` already returns a
  terminal status.
* Every response from an intent-protected route (success *or* error) carries
  `x-intent-receipt-id`.

## Receipt contents

| Field | Notes |
|---|---|
| `receiptId`, `version`, `status` | `authorized` · `succeeded` · `failed` · `rejected` |
| `action`, `target` | For rejections these are what the **endpoint required**, never what the caller claimed. |
| `chain`, `nonce`, `intentExpiry`, `intentSignature`, `intentSigner`, `intentDigest` | The admin's original signed intent, so it can be re-verified later — even after the admin key rotates (`intentSigner` keeps the key that was used). |
| `actor`, `route`, `requestId` | `requestId` is the correlation id from `RequestLoggingInterceptor`. |
| `requestDigest` | sha256 of the canonical request body with `adminIntent` removed. **The raw body is never stored.** |
| `authorizedAt`, `completedAt`, `outcome` | `outcome.resultDigest` (success) or `errorCode` / `errorMessage` (failure). Only `HttpException` messages are kept; any other error is reduced to its class name and `"Internal error"`. |
| `signer`, `signature` | ed25519 over `verdant-intent-receipt:v1\n` + canonical JSON of every field except `signature`, `reviews`, `auditHash`. The domain prefix means a receipt signature can never be replayed as an intent. |
| `auditHash` | Hash of the audit-chain entry for the latest transition (`intent-receipt/<receiptId>`). |
| `reviews[]` | Signed reviewer attestations, each bound to the receipt signature the reviewer saw. |

Each transition re-signs the receipt and is appended to the hash-chained
audit trail (`AuditService`), so both the current receipt and its history are
independently verifiable.

## Review API

All routes: `JwtAuthGuard` + `AdminGuard` (listed in
`api/src/test/route-authorization.matrix.ts`).

| Method & path | Purpose |
|---|---|
| `GET /admin/intent-receipts?status=&action=&target=&actor=&stale=true&limit=` | Newest first, max 500. |
| `GET /admin/intent-receipts/stats` | Counts by status, stale count, evictions, audit write failures, late outcomes, signer. |
| `GET /admin/intent-receipts/signing-key` | Public key for offline verification. |
| `GET /admin/intent-receipts/:id` | Receipt + derived `stale` / `reviewed` flags (not signed). |
| `GET /admin/intent-receipts/:id/verify` | Checks receipt signature, embedded intent signature, review signatures and audit-chain anchoring. |
| `POST /admin/intent-receipts/verify` | Same checks for an exported receipt (for example one attached to an incident ticket). |
| `POST /admin/intent-receipts/:id/reviews` `{disposition, note}` | `confirmed` · `disputed` · `reconciled_succeeded` · `reconciled_failed`. |

Review rules:

* `confirmed` needs a known outcome (terminal status).
* `disputed` is allowed on any terminal receipt, and on a stale one.
* `reconciled_*` is allowed **only** on a stale `authorized` receipt. It moves
  the receipt to `succeeded`/`failed` with `outcome.reconciledByReview` set, and
  re-signs it.
* Nothing can be reviewed while an action may still be in flight
  (`authorized` and not yet stale) → `409`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `INTENT_RECEIPT_SIGNING_SECRET` | unset → ephemeral key | Stellar secret seed. Must differ from `ADMIN_SECRET_KEY` and the other signer keys (enforced by `config:contract` outside development). It is listed in `ENV_UNIQUE_VARS`, so staging and production must use different keys. A malformed value **stops the app at boot**; it never falls back silently. |
| `INTENT_RECEIPT_STALE_MS` | `900000` (15 min) | Set this above the slowest legitimate action (for example, coupon distribution to a large holder set). |

## Operational edge cases

| Situation | Behaviour | What to do |
|---|---|---|
| Intent missing / expired / wrong action / wrong target / bad signature | `401`, `rejected` receipt, handler never ran | Re-sign with correct fields. A spike in `byStatus.rejected` for one actor is worth investigating. |
| Replayed nonce | `409`, `rejected` receipt carrying the replayed nonce | Expected for double-submits. The first receipt with that nonce is the real one. |
| Handler throws | `failed` receipt with client-safe error | Fix the cause and **sign a new intent** (the nonce is spent). |
| Client timeout / dropped connection | Receipt still finalised server-side | Look up the receipt by `x-intent-receipt-id`, or by `?action=&target=`, **before retrying**. This avoids double coupon distribution. |
| Process crash / deploy mid-action | Receipt stays `authorized`, shows `stale: true` after the threshold | Check the effect on-chain (Stellar tx history for the bond or contract, filtered by `authorizedAt`), then `reconciled_succeeded` / `reconciled_failed` with the evidence in `note`. |
| Handler returns after a reviewer reconciled it | Signed receipt is **not** rewritten. A `late_outcome` audit entry records what was observed; `stats.lateOutcomes` goes up. | Compare the late outcome with the reconciliation. If they disagree, add a `disputed` review. |
| Audit chain full / write error | Receipt still issued (`auditHash: null`); `stats.auditWriteFailures` goes up; `verify` reports `auditChainValid: false` | Audit capacity must not block an incident response. Restore audit capacity / durable store, and treat unanchored receipts as lower assurance. |
| Receipt signing fails | Guard throws, **action does not run** (fail closed); nonce already consumed | Fix the key config and re-sign the intent. |
| Receipt store at capacity (10,000) | Oldest *terminal* receipt is evicted (its audit entries remain); in-flight receipts are never evicted. `stats.evicted` goes up. | Export receipts you need to keep (`GET :id`) before they are evicted. |
| No signing key configured | Ephemeral key + boot warning; `signer.ephemeral: true` | Receipts stop verifying after restart. Configure a key in staging/production. |
| Receipt signing key rotated | Old receipts report `receiptSignatureValid: false` ("signed by a key other than the current…") | Before rotating, keep the old public key from `/signing-key` with exported receipts; verify old ones offline (below). |
| Admin key rotated | Embedded intents still verify (checked against stored `intentSigner`) | None. |
| Multiple API replicas | Receipts are per-process (in-memory, like `AuditService`) | Send `/admin/*` to one replica (sticky routing) or query each replica. See "Known limitations". |

## Offline verification

```ts
import { Keypair } from '@stellar/stellar-sdk';
import { receiptMessage } from 'api/src/intent-receipts/intent-receipt.service';

const ok = Keypair.fromPublicKey(receipt.signer.publicKey)
  .verify(receiptMessage(receipt), Buffer.from(receipt.signature, 'base64'));
```

`receiptMessage` drops the unsigned fields (`signature`, `reviews`,
`auditHash`, `stale`, `reviewed`) and canonicalises keys, so a receipt
fetched from the API can be verified exactly as returned.

## Compatibility & migration

* **Request/response shape of existing endpoints is unchanged.** The only
  addition is the `x-intent-receipt-id` response header on intent-protected
  routes.
* Status codes are unchanged: `401` for bad intents, `409` for replays, and
  handler errors pass through untouched. A failure to *finalise* a receipt is
  swallowed and never changes the action's response.
* `IntentGuard` and `IntentReceiptInterceptor` take the receipt service as
  `@Optional()`. Contexts that do not load `IntentReceiptsModule` (unit-test
  harnesses, `controller-guard.harness.ts`) keep the previous behaviour.
* There is no schema migration: receipts are in-memory and audit entries use the
  existing audit chain (`entityType = 'intent-receipt'`).
* `INTENT_RECEIPT_SIGNING_SECRET` is optional, so existing environment files
  stay valid.

## Rollback / recovery

1. **Disable receipts, keep intent enforcement:** remove `IntentReceiptsModule`
   from `AppModule.imports`. The guard and interceptor fall back to the
   pre-receipt behaviour, with no other change needed.
2. **Full rollback:** revert the commit. Clients that ignore
   `x-intent-receipt-id` are unaffected. Clients that read it should treat a
   missing header as "receipts unavailable".
3. **After any restart:** in-memory receipts are lost. For actions that were in
   flight during the restart, recover the intent nonce/target from request logs
   (`correlationId`) and reconcile against on-chain state. The audit chain is
   the second source when it is backed by `AuditDurableStore`.
4. **Suspected signing key compromise:** rotate `INTENT_RECEIPT_SIGNING_SECRET`,
   record the old public key, and re-verify recent receipts against the audit
   chain (`GET /api/v1/audit/verify/intent-receipt/<id>`). Receipt signatures
   alone are not trustworthy for the compromise window.

## Known limitations / follow-ups

* Receipt storage is in-memory and bounded, and so is `AuditService` today. A
  Postgres-backed store (same pattern as `AuditDurableStore`) is the natural
  next step for multi-replica deployments and restart durability.
* There is a single admin identity (`STELLAR_PUBLIC_KEY`), so reviewer and executor
  cannot be forced to differ. Once per-maintainer keys exist, `review` should
  refuse self-review.
