# Signed Webhook Replay-Window Enforcement (#530)

Code: `api/src/webhooks/webhook-verification.service.ts`
Tests: `api/src/webhooks/webhook-replay-window.spec.ts` (plus the existing
`webhook-verification.service.spec.ts`, `api/src/test/duplicate-suppression.spec.ts`
and `api/src/test/sensitive-content-boundary.spec.ts`).

A delivery is accepted only when **all** of these hold, checked in order:

1. The timestamp is a positive safe integer (ms since epoch). The middleware
   reads the header strictly (1 to 16 digits, nothing else): `"1700000000000abc"`,
   an empty header or a repeated header (array) is rejected with 400.
2. `now - timestamp <= replayWindowMs` (default 5 min) and
   `timestamp - now <= maxFutureSkewMs` (default: `replayWindowMs`).
3. The signature is a single string equal (timing-safe) to
   `HMAC-SHA256(secret, "<id>.<timestamp>.<JSON payload>")` for the current
   `secret` or one of `previousSecrets`.
4. The event id was not already processed (duplicate → acknowledged, not re-run; see
   [duplicate-suppression.md](duplicate-suppression.md)).

A body without an `id` is rejected (400). Previously the middleware invented a
random id, which could never be deduplicated and always failed the signature
check with a misleading `Invalid signature`.

## Configuration

| Field | Default | Notes |
|---|---|---|
| `replayWindowMs` | 5 min | Past tolerance; ids are remembered at least this long past their timestamp |
| `maxFutureSkewMs` | `replayWindowMs` | Set lower (e.g. 30 s) to stop a sender with a fast clock minting long-lived deliveries |
| `previousSecrets` | `[]` | Accepted during secret rotation |
| `dedupeWindowMs` | 72 h | Unchanged (#410) |

## Edge cases and recovery

- **NaN timestamps** used to pass both window comparisons; they are now
  rejected as `Invalid timestamp` before any other check.
- **Forged deliveries** never mark their id as processed, so an attacker cannot
  pre-burn a legitimate event id.
- **Handler failure / retry:** unchanged. A 5xx or dropped connection releases the
  id and the sender's retry is processed.
- **Secret rotation:** add the old secret to `previousSecrets`, switch `secret`,
  and remove the old entry once senders have moved. To roll back, swap them.
- **Process restart** forgets processed ids (in-memory store). A replay after a
  restart is still limited by the replay window.

## Compatibility

All new fields are optional and default to the previous behaviour. The only
behaviour changes are rejections of malformed input that could not have
passed signature verification before.
