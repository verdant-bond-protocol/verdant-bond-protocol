# Bond Issuance Quotes: Expiry and Stale-Price Rejection (#435)

Service: `api/src/bonds/issuance-quote.service.ts`

A quote locks the issuance price for one investor for a short window.

## Defaults

| Setting | Default | Meaning |
|---|---|---|
| `quoteTtlMs` | 60 000 | quote lifetime |
| `maxPriceAgeMs` | 30 000 | oldest acceptable price observation |
| `maxFutureSkewMs` | 5 000 | tolerated clock skew for price timestamps |
| `maxPriceDeviationBps` | 50 | allowed move between quoted and current price at acceptance |

All amounts are integer minor-unit strings, multiplied with `bigint`, so totals above `Number.MAX_SAFE_INTEGER` are exact.

## Paths

| Path | Result |
|---|---|
| Normal | `createQuote` returns an `open` quote; `acceptQuote` before `expiresAt` with a fresh, in-band price returns `accepted` |
| Stale price at creation | `400 STALE_PRICE`; no quote is created |
| Future-dated or malformed price | `400 INVALID_PRICE` |
| Expired (`now >= expiresAt`) | `410 QUOTE_EXPIRED`; the quote becomes `expired` |
| Price moved beyond the band | `409 PRICE_MOVED`; the quote becomes `rejected` and cannot be retried |
| Stale current price at acceptance | `400 STALE_PRICE`; the quote **stays open**, so the client can retry with a fresh price before expiry |
| Retry after success | accepting an `accepted` quote returns it unchanged |
| Authorization | only the investor the quote was issued to can accept it (`403 QUOTE_NOT_OWNED`) |

## Operations

- `expireDue()` sweeps open quotes past expiry. Run it from a scheduler. Acceptance also checks expiry, so the sweep is only for reporting accuracy.
- Prices at exactly `maxPriceAgeMs` old are accepted; one millisecond older is rejected.
- `configure()` validates overrides (non-negative integers, TTL > 0).

## Recovery and rollback

Quotes are short-lived and in memory. Nothing settles until a quote is accepted and the purchase is signed. After a restart, open quotes are lost and investors request new ones. That is safe, because a lost quote can never be accepted. Rolling back the service only removes the extra check: no stored data or contract changes.
