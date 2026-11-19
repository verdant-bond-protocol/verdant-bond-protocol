# Secondary-Market Order Cancellation Audit (#440)

Service: `api/src/marketplace/order-cancellation-audit.service.ts`

Every order cancellation is recorded once, in an append-only, hash-chained log, with a stable reason code.

## Reason codes and who may use them

| Code | owner | system | admin | Note required |
|---|---|---|---|---|
| `USER_REQUESTED` | yes | | | |
| `EXPIRED` | | yes | | |
| `INSUFFICIENT_BALANCE` | | yes | | |
| `STALE_PRICE` | | yes | | |
| `KYC_REVOKED` | | yes | yes | |
| `COMPLIANCE_HOLD` | | | yes | yes |
| `ADMIN_HALT` | | | yes | yes |

Owners can only cancel their own orders. Notes are trimmed and capped at 280 characters.

## Entry

Each entry records:

- `sequence` and `orderId`
- the order owner, plus the actor's address and role
- `reasonCode`, `note` and `idempotencyKey`
- `recordedAt`
- `prevHash` and `hash`

`hash` is the SHA-256 of the entry's fields in a fixed order, including `prevHash`. The first entry chains from 64 zeros.

## Paths

| Path | Result |
|---|---|
| Normal | entry recorded; `getForOrder`, `list` (filter by reason or role) and `summary` (counts per code) |
| Unknown code | `400 INVALID_REASON_CODE` |
| Missing key, missing or too-long note | `400 IDEMPOTENCY_KEY_REQUIRED`, `NOTE_REQUIRED`, `NOTE_TOO_LONG` |
| Second cancellation of the same order | `409 ORDER_ALREADY_CANCELLED` |
| Retry with the same idempotency key | returns the original entry; nothing new is appended |
| Authorization | `403 CANCELLATION_FORBIDDEN` (not the owner) or `403 REASON_NOT_ALLOWED_FOR_ROLE` |

## Integration and recovery

- Record the audit entry after `OrderStateService.transitionState(..., Cancelled)` succeeds. If the state transition fails with a version conflict, nothing is audited and the caller retries with fresh state. If the audit write fails after the transition, retry `record` with the same idempotency key.
- `verifyChain()` (or `verifyChain(exportedEntries)`) detects edited, removed or reordered entries, and reports the first broken sequence.
- The log is in memory in this slice. Persisting it, for example to the existing event ledger, needs no format change, because entries are already self-verifying.
