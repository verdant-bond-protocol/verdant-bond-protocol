# Invitations & collaboration workflow (#265)

Abuse-resistant collaboration for bond/project scopes: authenticated role
holders invite wallets at a strictly lower role, invitations expire, and
acceptance always grants the role fixed server-side at creation.

## Model

- **Roles** (`ROLE_RANK`): `viewer` (0) < `contributor` (1) < `project_admin`
  (2) < `issuer_admin` (3), per scope (e.g. `bond:42`).
- **Invitation states**: `pending → accepted | revoked | expired`.
- **Expiry**: default TTL 7 days (`DEFAULT_INVITATION_TTL_MS`), overridable
  per invitation. Expired invitations are flipped lazily on read/accept.
- **Server-side role validation**:
  - creation requires the inviter to hold a role of rank ≥ the invited role
    in the scope (and ≥ `contributor`) — inviting above your own role is
    rejected with `role_escalation_rejected`;
  - acceptance grants exactly `invitation.role`; the invitee never posts a
    role, so no client-driven escalation exists;
  - revocation is allowed for the inviter or any higher-rank holder.
- **Throttling**: at most 5 invitations per inviter per rolling 60-minute
  window (`INVITES_PER_WINDOW` / `INVITE_WINDOW_MS`); the 6th attempt within
  the window raises `rate_limited`.

## API

All routes require wallet authentication (`JwtAuthGuard`); the authenticated
wallet is the actor.

| Route | Behaviour |
| --- | --- |
| `POST /api/v1/invitations` | create a pending invitation from the caller |
| `POST /api/v1/invitations/:id/accept` | accept (invited wallet only) |
| `POST /api/v1/invitations/:id/revoke` | revoke (inviter or higher role) |
| `GET /api/v1/invitations/:id` | fetch one invitation |
| `GET /api/v1/invitations` | list invitations addressed to the caller |

Error responses are `InvitationError` with a stable `code`:
`role_escalation_rejected`, `invitation_not_found`, `invitation_not_pending`,
`invitation_expired`, `invitation_revoked`, `already_a_collaborator`,
`rate_limited`, `invalid_input`.

## Design decisions & tradeoffs

- **In-memory registry** (like the impersonation/recovery modules) keeps the
  workflow stateless of a database; a persistent store can back the same
  service interface when invitations must survive restarts.
- **The granted role is fixed at creation** rather than at acceptance: the
  invitation record is the authorization decision, and acceptance is merely a
  claim of an already-validated grant.
- **Bootstrap rule**: the first `issuer_admin` of a scope can be granted
  without a prior holder (project creation); afterwards escalation checks
  apply to everyone.
- Expiry is enforced at acceptance time against the stored `expiresAt`, so no
  background sweeper is required; `list`/`get` also flip stale rows.

## Tests

`api/src/invitations/invitation.service.spec.ts` covers creation (default
TTL, escalation rejection, unprivileged inviter, already-a-collaborator),
acceptance (granted role, wrong-invitee rejection, expiry), revocation
(inviter, higher role, unrelated wallet) and the rolling-hour throttle.

```bash
pnpm --filter api test -- invitation
```
