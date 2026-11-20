# Investor Eligibility Cache Invalidation (#438)

Service: `api/src/auth/investor-eligibility-cache.service.ts`. It is registered and exported by `AuthModule`.

The service caches eligibility decisions per `(investor, bond)` for `ELIGIBILITY_CACHE_TTL_MS` (30 s).

## Invalidation

`KycService.transitionStatus` calls `onKycStatusChanged(address, from, to)` after every real status change: verify, reject, expire or admin update. No-op transitions (same status) do not invalidate.

Invalidation does three things:

1. bumps the investor's **generation**
2. deletes all of that investor's cached entries (other investors are untouched)
3. appends to an invalidation log (`listInvalidations`), capped at 1 000 entries

## Race safety

`getOrCompute` reads the generation **before** evaluating eligibility. When it stores the result, the write is discarded if the generation changed in between. So a lookup that started before a KYC revocation cannot put a stale "eligible" back into the cache.

## Paths

| Path | Result |
|---|---|
| Normal | first lookup computes; later lookups hit until the TTL expires |
| KYC change | all of the investor's entries are dropped immediately |
| Failure | if the evaluation throws, nothing is cached and the next call retries |
| Retry | repeated invalidations are safe; stale writes return `false` |
| Authorization | `flushAll` requires an admin actor (`403 ELIGIBILITY_FLUSH_FORBIDDEN`) |

## Recovery and rollback

- If cached decisions are suspected wrong, an admin calls `flushAll`, and every investor is re-evaluated on next use.
- The cache is in memory and per instance. A restart simply empties it.
- `KycService` takes the cache as an `@Optional()` dependency. Removing the provider rolls the feature back without other changes.
- Multi-instance deployments must invalidate on every instance (for example, by broadcasting KYC transitions). Until then, keep the TTL short.
