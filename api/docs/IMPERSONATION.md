# Scoped Maintainer Impersonation (Issue #264)

Support debugging needs a maintainer to reproduce a user's report *as* that
user — see the exact bond list, the exact subscription state, the exact error.
Handing a maintainer the user's credentials, or a broad "read everything" key,
is the wrong shape for that: it outlives the ticket and grants far more than
the reproduction needs.

## Design

An impersonation session is a narrow, expiring grant with four properties:

| Property | Enforcement |
|---|---|
| **Scoped** | `allowedOperations` is an explicit allow-list decided at session start. `performOperation` denies anything not listed — including operations that are harmless in isolation — and the denial is audited. Default posture is deny. |
| **Time-limited** | `ttlSeconds` (default 15 min), hard-clamped to a 30-minute maximum. A caller asking for a week gets 30 minutes; a longer investigation starts a new session, which produces a new audit trail rather than one unbounded grant. Expiry is checked on **every** operation, so a session cannot outlive its window by staying idle. |
| **Fully audited** | `started`, `operation_allowed`, `operation_denied`, `expired`, `ended` events, each carrying the maintainer principal, the target user, the operation, and a reason. Denials are audited too, so a maintainer probing beyond their grant is visible, not silent. |
| **Reason-bound** | A non-empty `reason` is required to start. It is stored on the session, so an audit reader knows *why* the grant existed, not just that it did. |

Admin authorisation reuses the repo's existing admin principal
(`STELLAR_PUBLIC_KEY`, same check as `AdminGuard`) rather than introducing a
second notion of admin. The maintainer identity comes from the authenticated
request (`req.user.walletAddress`), never from the request body, so a caller
cannot create a session attributed to someone else.

## Dangerous mutations

Mutations are denied by default even if listed in the scope. A session whose
scope includes, say, `bond.migrate` still gets
`denialReason: 'dangerous_mutation_blocked'` unless it was started with
`allowDangerousMutations: true` — an explicit, separate opt-in that never
travels with scope alone.

## Visible indicators

`GET /api/v1/impersonation/indicators/:targetAddress` lists the active
impersonation sessions for a user and stays JWT-authenticated for any
signed-in principal. An indicator the impersonated user cannot see is not an
indicator: the user is entitled to know someone is acting as them.

## Denial reasons

Denials are never silent. `performOperation` returns one of:

| `denialReason` | Meaning |
|---|---|
| `no_active_session` | Unknown session id |
| `revoked` | The session was already ended (explicitly or by expiry) |
| `expired` | Checked per operation; the session ended at `expiresAt` |
| `operation_not_in_scope` | Operation missing from the allow-list |
| `dangerous_mutation_blocked` | Mutation attempted without the explicit grant |

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/impersonation/sessions` | Admin | Start a scoped session |
| `DELETE` | `/impersonation/sessions/:id` | Admin | End it (owner-only, idempotent) |
| `GET` | `/impersonation/sessions/:id` | JWT | Inspect a session |
| `GET` | `/impersonation/indicators/:targetAddress` | JWT | Visible indicator |
| `GET` | `/impersonation/audit` | Admin | Full audit trail |

## What is *not* covered

- **Elevated confirmation flow.** `allowDangerousMutations` is an explicit
  session property, but there is no second-person approval workflow (e.g. a
  second admin countersigning a dangerous session). That needs a decision
  about who may countersign, which is maintainers' call, not this module's.
- **Enforcement at the guard layer.** Sessions gate operations when code calls
  `performOperation`. Plumbing that call into every existing guard so an
  impersonation token is recognised by *all* routes is an integration step
  across modules, kept out of scope here so this module can land without
  touching auth behaviour that already works.
