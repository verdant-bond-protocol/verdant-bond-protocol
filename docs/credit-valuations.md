# Credit valuations (#204)

`GET /api/valuations` returns the fiat-equivalent price of one whole credit per
credit type, aggregated from every configured price feed, with explicit
staleness metadata on every value. Code: `api/src/valuation/`.

## Sources

Feeds are configured with `CREDIT_PRICE_FEEDS` (see `.env.example`). Each feed
answers `GET <url>?creditType=<Carbon|BlueCarbon|Biodiversity|Basket>` with:

```json
{ "price": 12.5, "currency": "USD", "observedAt": "2026-09-25T10:00:00Z" }
```

A feed that times out (5 s), answers non-2xx, or returns a body that does not
match this contract is reported as a source `error` — never as a price. Every
credit type and every feed is queried independently, so an outage of one feed
or one credit type does not affect the others.

## Outlier handling

The same principle as the oracle's cross-source anomaly detection
(`api/src/oracle/anomaly.detector.ts`): compare against the median.

1. A quote is **invalid** if its price is not positive, it is quoted in another
   currency than `VALUATION_CURRENCY`, or its timestamp is in the future.
2. A quote is **stale** if it is older than the credit type's `maxAgeSeconds`.
3. The remaining **fresh** quotes are compared with their median; a quote whose
   relative deviation exceeds the credit type's `tolerance` is an **outlier**
   and is excluded.
4. The price is the median of the quotes that agree.

The median is used because a single wrong feed cannot move it; a mean would
pass part of that error through to investor-facing reports.

| Default policy | Fresh for | Tolerance |
| --- | --- | --- |
| Carbon | 2 days | 25% |
| BlueCarbon | 7 days | 25% |
| Basket | 7 days | 25% |
| Biodiversity | 30 days | 35% |

Biodiversity credits reprice least often and have the least standardised
units, so they get the longest window and widest tolerance. Override per credit
type with `CREDIT_VALUATION_POLICY`.

## Status of a valuation

| Status | Meaning | Report label |
| --- | --- | --- |
| `current` | ≥ 2 fresh sources agree within tolerance | `Current — median of N agreeing sources` |
| `estimated` | Fresh price, but not cross-checked (one source) or sources disagree | `Estimated — single source, not cross-checked` / `Estimated — N sources disagree beyond X%` |
| `stale` | No fresh price; newest stale quote or last known price | `Stale — last known price, N days old` |
| `unavailable` | No price has ever been observed | `Unavailable — no price observed` |

Every valuation carries `asOf` (when the price was observed, not when it was
computed), `ageSeconds`, the `label` above, and a per-source breakdown with each
source's status (`accepted`, `outlier`, `stale`, `invalid`, `error`) and reason.
The report's `summary` groups credit types by status, so a reader sees at a
glance which values are not current.

Each `current` or `estimated` price is persisted in Redis as the last known
price (365-day TTL). When every source for a credit type is down, the report
degrades to that price, labelled stale with its age, instead of failing.
