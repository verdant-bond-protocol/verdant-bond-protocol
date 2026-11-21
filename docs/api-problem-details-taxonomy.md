# API Problem-Details Taxonomy

The public Verdant Bond Protocol API reports every failure as an [RFC 7807
`application/problem+json`](https://www.rfc-editor.org/rfc/rfc7807) document.
This document is the stable contract clients, SDKs, and support tooling depend
on. It is guarded by `api/src/common/errors/error-codes.contract.spec.ts`, which
fails the build if a code, its retryability, or its remediation hint drifts.

The single source of truth is
[`api/src/common/errors/error-codes.ts`](../api/src/common/errors/error-codes.ts).

## Response shape

```jsonc
{
  "type": "https://errors.verdant-bond-protocol.org/SETTLEMENT_FAILED",
  "title": "SETTLEMENT FAILED",
  "status": 400,
  "detail": "The settlement transaction failed on the network. You can safely retry.",
  "code": "SETTLEMENT_FAILED",
  "instance": "/api/marketplace/buy",
  "correlationId": "9f0c1f2a-...",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "retryable": true,
  "remediation": "Retry with an idempotency key. If it persists, inspect `contract.rawErrorCode` and the settlement runbook.",
  "errors": [{ "field": "amount", "message": "amount must be positive" }],
  "context": { "riskScore": 82, "band": "high" },
  "contract": { "address": "C...", "method": "buy_order", "rawErrorCode": 5 }
}
```

Field guarantees:

| Field | Guarantee |
| --- | --- |
| `type` | Stable URI derived from `code`. Safe to branch on. |
| `code` | One of the frozen machine codes below. Never localized. |
| `detail` | Client-safe. **Never** contains stack traces, SQL, hostnames, or internal identifiers. |
| `title` | Human-readable, derived from `code`. |
| `retryable` | Whether the *same* request may be safely retried. |
| `remediation` | Actionable next step a client can surface to an operator. |
| `correlationId` | Present when the request carried/propagated one; echoed in the `x-correlation-id` response header. |
| `errors[]` | Validation failures only. `field` is best-effort. |
| `context` | Non-sensitive, operation-specific signal (e.g. risk assessment). |
| `contract` | Settlement failures only. Raw Soroban fields plus the stable contract `code`, `category`, `errorClass` and `retryStrategy` (#641, see [error-mappings.md](error-mappings.md)). |

## Frozen machine codes

| Code | HTTP | Retryable | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| `VALIDATION_FAILED` | 400 | no | Request body/query failed validation. | Correct the flagged fields and resubmit. |
| `UNAUTHORIZED` | 401 | no | Missing/expired credentials. | Obtain a fresh access token and retry. |
| `FORBIDDEN` | 403 | no | Caller lacks the required role/permission. | Request the role or complete KYC. |
| `NOT_FOUND` | 404 | no | Resource missing, archived, or deleted. | Verify the identifier. |
| `INSUFFICIENT_BALANCE` | 400 | no | Wallet/escrow cannot cover the operation. | Fund the account, then retry. |
| `SETTLEMENT_FAILED` | 400 | yes | On-chain settlement failed. | Retry with an idempotency key. |
| `RATE_LIMIT_EXCEEDED` | 429 | yes | Too many requests. | Back off using `Retry-After`. |
| `QUOTA_EXCEEDED` | 400 | no | Usage quota exhausted. | Wait for the window to reset. |
| `STEP_UP_REQUIRED` | 401 | yes | Additional verification required. | Complete step-up and resend with `x-risk-step-up-token`. |
| `RISK_REVIEW_REQUIRED` | 403 | no | Operation flagged, not auto-executed. | Contact support with the `correlationId`. |
| `INTERNAL_ERROR` | 500 | no | Unexpected server failure. | Retry once; then contact support with `correlationId`. |
| `QUEUE_BACKPRESSURE` | 429 | yes | Queue admission bound reached. | Back off and poll `GET /api/v1/jobs/queue/status`. |
| `BOND_NOT_ACTIVE` | 400 | no | Bond not in Active state. | Check bond status before subscribing/transferring. |
| `BOND_MATURED` | 400 | no | Bond lifecycle is terminal. | Redeem outstanding balance. |
| `DUPLICATE_SUBSCRIPTION` | 409 | no | Subscription already in progress. | Wait for the existing subscription. |
| `COUPON_ALREADY_CLAIMED` | 409 | no | Coupon period already claimed. | No action needed. |
| `OWNERSHIP_TRANSFER_PENDING` | 409 | no | A transfer proposal is already pending. | Cancel or complete it first. |
| `OWNERSHIP_TRANSFER_EXPIRED` | 400 | no | Acceptance window elapsed. | Initiate a fresh proposal. |
| `RECEIPT_PENDING` | 503 | yes | Governance action applied; signed receipt not yet issued (#632). | Retry with the same `Idempotency-Key`. |
| `PRICE_IMPACT_EXCEEDED` | 400 | no | Secondary-market trade breaches the tier or caller price-impact limit (#638). | Use `context.suggestedMaxAmount` / `context.bestOrderId`, or loosen `maxPriceImpactBps`. |

The HTTP column is the canonical status for each code; the response's own
`status` field is authoritative. The machine `code`, `retryable` flag and
client-safe `remediation` text are frozen by `error-codes.contract.spec.ts`
(`FROZEN_CODES`, `FROZEN_RETRYABLE`, and `FROZEN_COPY`, which pins the exact
`safeMessage`, `remediation` and operator-only `remediationHint` strings).

> Changing any value in this table requires editing `error-codes.ts`, the frozen
> expectations in `error-codes.contract.spec.ts`, and this document in the same
> commit. A wording-only change to a safe message or remediation now fails the
> build too, so it is reviewed as a public-contract change.

## How to add a code

1. Add the enum member to `ErrorCode` in `error-codes.ts`.
2. Add its `retryable`, `safeMessage`, `remediation` and `remediationHint` to
   `ErrorTaxonomy`. Keep operator tooling (runbook links, Grafana/ Horizon
   queries) in `remediationHint` only — never in `safeMessage` or `remediation`.
3. Extend `FROZEN_CODES`, `FROZEN_RETRYABLE` and `FROZEN_COPY` in
   `error-codes.contract.spec.ts`.
4. Update the table above and add an HTTP assertion in
   `api-problem.contract.spec.ts` if the code has a distinct status/context.
5. Prefer throwing `ApiProblemException` (or `DomainException`) over raw
   `HttpException` so the stable `code` and `remediation` are preserved.

## Deprecation and migration

Codes are **append-only**: never rename, reuse or delete a value in `ErrorCode`.
To retire a code, add a replacement code, return the new code from new code
paths while continuing to accept the old code for at least one major version,
and mark the old entry as deprecated in this table with a sunset notice (the
field-versioning precedent is `SchemaEvolutionGuardrails`). Only remove the old
entry in a major release, and remove it from `FROZEN_CODES` in the same commit.
Because the client-safe text is frozen, a deprecation notice cannot be slipped
into `remediation` silently — it must be an explicit reviewed edit.

Client rollout rule: treat an unrecognised `code` as non-retryable and render
`detail` plus `remediation`. This lets a new code ship before SDKs know it.

## Operational edge cases

- **Unknown exception**: the global `Rfc7807ExceptionFilter` maps anything it
  does not recognise to `INTERNAL_ERROR` and drops internal detail. The
  `correlationId` is the only safe join key to server logs.
- **Mapped by status only**: a `HttpException` without an explicit taxonomy
  code is mapped from its HTTP status (`400 → VALIDATION_FAILED`, `401 →
  UNAUTHORIZED`, `403 → FORBIDDEN`, `404 → NOT_FOUND`, `429 →
  RATE_LIMIT_EXCEEDED`, else `INTERNAL_ERROR`). This preserves legacy behaviour
  while still guaranteeing a stable `code`.
- **Contract exceptions** are re-tagged as `SETTLEMENT_FAILED` with the raw
  Soroban code under `contract` so operators can follow `docs/error-mappings.md`.

## Failure modes & rollback

- If a new code is deployed before clients understand it, clients should treat
  any unknown `code` as non-retryable and surface `detail`/`remediation`.
- To roll back, revert the enum/taxonomy/spec change together; the frozen
  contract test prevents a partial rollback from shipping.
- Disabling the filter is **not** supported; it is registered as the global
  `APP_FILTER` and all modules rely on the uniform shape.
