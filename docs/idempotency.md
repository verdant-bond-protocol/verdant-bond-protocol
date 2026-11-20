# Idempotency Keys (#114)

State-changing API endpoints accept an `Idempotency-Key` header so that
client network retries do not produce duplicate on-chain transactions or
allocate new nonces.

## Header

```
Idempotency-Key: <client-generated-key>
```

Send the **same key** when retrying a request that may have timed out before
the client received a response. The server returns the original result
instead of re-executing the mutation.

## Covered endpoints

- `POST /bonds/:id/subscribe`
- `POST /bonds/:id/transfer`
- `POST /bonds/:id/claim`
- `POST /marketplace/list`
- `POST /marketplace/buy`
- `POST /marketplace/deposit`
- `POST /marketplace/withdraw`

## Behaviour

| Scenario | Result |
|---|---|
| First request with a key | Executes, stores result + transaction hash |
| Same key + identical payload (retry) | Returns the original stored result (deduplicated) |
| Same key + **different** payload | `409 Conflict` |
| Same key still in progress | `409 Conflict` (poll/safe to retry) |
| No `Idempotency-Key` header | Treated as a normal (non-idempotent) request |

Pending operations can be resumed: a client that receives `409 in progress`
should poll with the same key until a terminal result is returned.

## Key generation (frontend)

`ApiService.generateIdempotencyKey(prefix)` returns a UUID-scoped key, e.g.
`subscribe-<uuid>`. The frontend attaches it for the duration of a single
user action and reuses it across retries of that action.

## Retention

Records are stored in Redis under `idem:<key>` with a TTL of
`IDEMPOTENCY_TTL_SECONDS` (default **86400 = 24h**). After expiry the key is
treated as new. Configure the retention window via the environment variable.
