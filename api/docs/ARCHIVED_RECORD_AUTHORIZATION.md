# Authorization for hidden and archived records

An archived record is a **hidden** record: it is off the default read paths but
never destroyed. This note pins who can reach the archive, restore and audit
paths of the partial-failure board (`/api/v1/operations/failures`) and what is
guaranteed about a record while it is hidden. The behaviour is covered by
`src/failures/partial-failure.controller.spec.ts`.

## Who may do what

The whole controller sits behind `JwtAuthGuard` and `AdminGuard`, so the rules
below apply to every route, including the audit view.

| Path | Who | Notes |
|---|---|---|
| `GET /` (board) | admin | Archived rows are off the board by default but **counted** in `archived`. |
| `GET /?includeArchived=true` | admin | Opt-in audit view. Rows keep their `lifecycle` attribution. Only boolean `true` or the exact string `true` opt in; `TRUE`, `1`, `yes`, `''` and `false` do not. |
| `GET /unresolved` (operator queue) | admin | Never lists archived records and never counts them in `totals`. |
| `GET /:id` | admin | An archived record is still readable by id so the audit trail stays reachable. |
| `POST /:id/archive` | admin | Needs a non-blank `reason`. The actor is the token's wallet; an `actor` in the body is ignored. |
| `POST /:id/restore` | admin | Actor taken from the token. The archive stays in `history`. |
| `POST /:id/retry`, `/resolve` | admin | Refused with 400 while the record is archived. |

## `AdminGuard` edge cases

- The admin is the wallet equal to `STELLAR_PUBLIC_KEY`, compared **exactly**:
  a lower-cased or whitespace-padded address is not the admin.
- If `STELLAR_PUBLIC_KEY` is unset the guard fails closed (`Admin key not
  configured`), even for a request that carries a user.
- A request with no user, or a user with no wallet, is rejected.
- Rejections are `401 Unauthorized` today (not `403`), for authenticated
  non-admins as well as anonymous callers.

## Edge cases on transitions

| Case | Result | State after |
|---|---|---|
| Archive without a reason (missing or blank) | 400 | Unchanged, still on the board |
| Archive an already archived record | 409 | Original actor, time and reason kept; history not extended |
| Restore a record that is not archived | 409 | Unchanged |
| Archive, restore or read an unknown id | 404 | n/a |
| Retry or resolve an archived record | 400 | Unchanged: `retryCount`, `status` and `resolvedAt` are not touched |

## Recovery and rollback

Archiving is reversible. `POST /:id/restore` returns the record to the default
board and to the operator queue, and work actions are accepted again. The
archive remains in `lifecycle.history` (append-only), so "archived then
restored" stays distinguishable from "never archived". There is no hard delete.

## Not covered here

Records are held in memory by `PartialFailureService`, so archive state is lost
on restart. Persisting it is a separate change.
