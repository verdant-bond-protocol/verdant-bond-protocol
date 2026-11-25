# Stale sessions and token revocation

**Vertical slice:** wallet session lifecycle in the API auth module. It adds a
per-wallet session epoch and a per-session deny-list; token issuance, every
guarded route, and refresh now check both.

## Files

| File | Purpose |
|------|---------|
| `api/src/auth/session-revocation.interface.ts` | `SessionClaims`, `canRevokeSessions()` authorization rule, epoch TTL. |
| `api/src/auth/session.service.ts` | Epoch bump (`revokeAll`), jti deny-list (`revokeToken`), `assertActive()`, Redis + in-process mirror. |
| `api/src/auth/auth.service.ts` | Stamps `sv`/`jti` on access + refresh tokens; refresh refuses stale sessions. |
| `api/src/auth/jwt.strategy.ts` | Calls `assertActive()` for every JWT-guarded route. |
| `api/src/auth/auth.controller.ts` | `POST /auth/logout`, `POST /auth/sessions/revoke/:address`. |
| `api/src/auth/session.service.spec.ts` | 14 tests: normal / failure / retry / authorization. |

## Semantics

- `sv` (session version) is a monotonic counter stored at
  `session:epoch:<lowercase-address>` with a 30-day TTL (longer than the 7-day
  refresh lifetime). `revokeAll` increments it → **all** tokens minted at an
  older version are stale.
- `jti` is one random UUID per login, shared by the access and refresh tokens.
  `revokeToken(jti)` adds it to `session:revoked:<jti>` → only that session is
  revoked; a sibling session still works.
- `assertActive()` checks the deny-list first, then requires `claims.sv ?? 0 ===
  currentVersion`. An exact match (not `<`) is intentional: a token from a
  different epoch must never be honoured.

### Endpoints

| Route | Guard | Effect |
|-------|-------|--------|
| `POST /auth/logout` | JWT | Revokes the caller's own sessions. |
| `POST /auth/sessions/revoke/:address` | JWT | Revokes another wallet's sessions; allowed only for self, a maintainer/admin role, or the `auth:sessions:revoke` / `manage_incidents` permission. Enforced twice (controller + service). |

## Paths covered by tests

- **Normal:** a freshly issued token passes; legacy tokens pass at epoch 0;
  revoking one session leaves siblings intact.
- **Failure:** `revokeAll` makes older tokens stale; revoking also invalidates
  legacy tokens; unreadable Redis fails closed with 503; failed revokes surface
  an error instead of silently succeeding.
- **Retry:** `revokeToken` is idempotent; after a Redis outage a retry succeeds;
  the in-process mirror still enforces recent revocations while Redis is down.
- **Authorization:** self/admin/permission allowed, stranger forbidden with no
  side effect; `JwtStrategy` rejects a stale token on any guarded route.

## Edge cases

- **Legacy tokens:** tokens without `sv`/`jti` are treated as version 0 with no
  jti. A single `revokeAll` invalidates all of them, which is the desired
  "revoke everything" behaviour during the rollout.
- **Exact epoch match:** after an epoch key expires (only possible after 30 days
  of inactivity — past the refresh lifetime) a token with an `sv` greater than
  0 is stale rather than accidentally valid again.
- **Partial revocation:** a revoked `jti` fails before the epoch check, so the
  operator can tell a single-device logout ("Session has been revoked") from a
  global one ("Session is stale").
- **Multiple instances:** Redis is the source of truth, so a revocation on one
  instance is visible to all others on the next request; the mirror is only a
  short-outage fallback and is never preferred while Redis is reachable.
- **Outage policy:** default is **fail closed** — if neither Redis nor the
  mirror can answer, requests get 503 rather than accepting a possibly revoked
  token. `SESSION_REVOCATION_FAIL_OPEN=true` flips this to availability-first.

## Recovery / rollback behaviour

- Revocation is intentionally one-way: there is no "unrevoke" endpoint. The
  recovery from an accidental global revoke is for the user to sign in again,
  which issues a token at the *new* epoch. This is a deliberate safety tradeoff.
- A failed revoke (Redis unavailable) leaves the epoch unchanged and returns
  503, so the client can retry; no half-applied state is possible because the
  epoch bump and jti write are single Redis commands.
- In fail-open mode a revocation attempted during an outage is mirrored in the
  process only. When Redis recovers, operators should replay the revocation so
  other instances learn it (the operation is idempotent).
- To roll back the *feature* in an emergency: remove the `assertActive()` call
  from `JwtStrategy.validate` behind a feature flag; existing tokens (which now
  carry `sv`/`jti`) remain valid JWTs, so this is a safe, reversible switch.

## Contract compatibility / migration plan

1. **API surface:** existing `/auth/challenge`, `/auth/verify`, `/auth/refresh`
   and `/auth/profile` responses are unchanged. `POST /auth/logout` and
   `POST /auth/sessions/revoke/:address` are additive. `AuthenticatedUser`
   gains two *optional* fields, so existing consumers are unaffected.
2. **Deploy:** no DB or contract migration. The Redis epoch key is created on
   first use (absent = version 0). Existing tokens keep working until their
   natural expiry or the first revocation.
3. **Optional one-time mass invalidation:** call `revokeAll(address, adminActor)`
   for a wallet to force all its old sessions to re-authenticate. Do this only
   during an incident — it is not necessary for the rollout.
4. **Rollback:** as described above; no data cleanup is required because
   revoked keys expire automatically after 30 days.
