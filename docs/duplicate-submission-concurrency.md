# Duplicate Submission Concurrency — Actor-Scoped Slice

This document covers a focused addition to the existing idempotency layer
(`docs/idempotency.md`, issue #114; retry claims from #348). It does not change
the global `IdempotencyInterceptor` or the `Idempotency-Key` wire contract.

Code: `api/src/common/concurrency/actor-scoped-idempotency.ts`
Tests: `api/src/common/concurrency/duplicate-submission-lifecycle.spec.ts`

## Why this slice

The global interceptor fingerprints a request as
`sha256(method + path + body)` and stores it under `idem:<client-key>`. The
authenticated subject is not part of either value. Consequences:

- two investors who independently choose the same key collide;
- a caller who learns another caller's key can replay that caller's cached
  result (a cross-tenant read of a mutation response).

`ActorScopedIdempotency` is an opt-in guard that namespaces the storage key with
`sha256(actorId)` before delegating to the unchanged `IdempotencyService`.
Because the namespace is new, **no existing in-flight key can collide with it**.

## API

```ts
const guard = new ActorScopedIdempotency(idempotencyService);
const sub = { key, actorId: req.user.sub, method, path, body };

const { decision, result } = await guard.begin(sub);
// 'execute'  -> run the mutation, then guard.complete(sub, result, status)
// 'replay'   -> return the cached result, do not run the mutation
// 'conflict' -> 409: in progress, payload changed, or state unreadable

// on downstream failure:
await guard.fail(sub, error, statusCode); // records status 'error', releases the retry claim
```

`actorId` must come from the verified JWT (`sub`), never from a client header.

## Verification paths

| Path | Behaviour |
|---|---|
| Normal | Of 20 concurrent identical submissions, exactly one receives `execute`; the rest get `conflict`. A later call replays the stored result without a new side effect. |
| Failure | A recorded `error` lets the same key be claimed again. Unreadable/unreservable state fails closed with `conflict` — the mutation is never executed. |
| Retry | After a failure, exactly one of 12 concurrent retries runs; further failures can themselves be retried because `complete()` releases the claim. |
| Authorization | The same client key and payload from two different actors are independent records with independent results; the raw actor id never appears in the Redis key. |

Run with:

```bash
cd api && npx jest src/common/concurrency/duplicate-submission-lifecycle.spec.ts
```

## Edge cases and recovery

- **Different payload, same key.** `begin()` returns `conflict` (the fingerprint
  check runs before status checks), matching the documented 409 contract.
- **Lost reply after a successful write.** The caller retries with the same
  key/actor; `begin()` returns `replay` with the original result and status code.
- **Crash between claim and completion.** The pending record remains until its
  TTL. There is no forced takeover of a `pending` record — that would risk a
  double mutation. Operators may wait for the TTL or delete the single scoped
  key (`actor:<sha256(sub)>:<key>`) after confirming the side effect did not land.
- **Retry claim expiry.** The underlying `RETRY_CLAIM_TTL_SECONDS` (60s) still
  applies; a claim older than that can be taken over by another retry.
- **Multiple API instances.** State lives in Redis, so the guard is safe across
  instances; unlike the in-memory webhook dedupe, it survives restarts.

## Contract preservation and rollback

- No endpoint is wired to this guard automatically, so no existing request
  contract, header, status code or stored key changes.
- To roll out: adopt the guard on one mutation endpoint, keep the client's
  existing `Idempotency-Key` header, and populate `actorId` from the JWT. Old
  interceptor records and new actor-scoped records coexist under different key
  prefixes; no backfill is required.
- To roll back: stop constructing the guard and let the route fall back to the
  global interceptor (or to no idempotency). Actor-scoped keys expire under the
  normal `IDEMPOTENCY_TTL_SECONDS` (default 24h) and need no deletion.
- If both mechanisms are active on a route, the guard's key namespace is
  distinct from the interceptor's, so each maintains its own dedup record. Use
  only one on a given route to avoid divergent replay results.
