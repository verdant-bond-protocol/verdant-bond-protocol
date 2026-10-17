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
| `contract` | Settlement failures only. Raw Soroban fields for runbook lookup. |

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

> Changing any value in this table requires editing both `error-codes.ts` and
> the frozen expectations in `error-codes.contract.spec.ts` in the same commit.

## How to add a code

1. Add the enum member to `ErrorCode` in `error-codes.ts`.
2. Add its `retryable`, `safeMessage`, and `remediation` to `ErrorTaxonomy`.
3. Extend `FROZEN_CODES` and `FROZEN_RETRYABLE` in
   `error-codes.contract.spec.ts`.
4. Update the table above.
5. Prefer throwing `ApiProblemException` (or `DomainException`) over raw
   `HttpException` so the stable `code` and `remediation` are preserved.

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
