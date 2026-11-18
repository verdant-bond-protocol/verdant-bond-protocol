# Degraded-workflow resilience slice

A focused vertical slice that connects four existing capabilities without
introducing a new persistence layer or changing any public wire contract:

| Goal | Where it lands |
|------|----------------|
| End-to-end failure injection for critical workflows | `WorkflowResilienceService.execute()` drives `PayoutRedemptionFailureInjectionService` over HTTP and folds the result into a user-facing status view. |
| User-facing status for degraded dependencies | `getUserFacingStatus()` embeds the existing `StatusReport` unchanged and adds a plain-language headline + `degraded[]` list. |
| Contract tests for permission changes and hidden records | `permission-hidden-records.contract.spec.ts` pins the role-diff report and every visibility rule, including search-hidden and archived records. |
| Property tests for boundary numeric and timestamp values | `boundary-properties.spec.ts` runs deterministic seeded properties (bigint/i128, date range, lifecycle transitions). |

Implementation: `src/resilience/`. Verification: `src/resilience/*.spec.ts` and
`test/resilience.e2e-spec.ts`.

## Running it

```bash
cd api
npm install                       # package-lock is out of sync with package.json
npx jest --runInBand src/resilience             # unit / contract / property
npx jest --config ./test/jest-e2e.json --runInBand test/resilience.e2e-spec.ts
```

The e2e probe controller uses the real services with a stubbed Redis health
check and oracle incident repository, so no external services are needed.

## Behaviour by path

| Path | Trigger | Result |
|------|---------|--------|
| Normal | No injection rule | `injected=false`, `recoveryAction=NONE`, status `healthy`. |
| Failure + retry | `TRANSIENT_RPC_TIMEOUT`, `PRE_COMMIT_NETWORK_RESET`, or `CORRUPTED_NONCE` rule | Injected, retried, `recoveryAction=AUTO_RETRY`; no lingering degradation. |
| Failure, no recovery | `UNDERFUNDED_REDEMPTION_POOL` | `recovered=false`, component set to `degraded`, a critical partial failure is recorded, `recoveryAction=OPERATOR_RECOVERY_REQUIRED`. |
| Authorization | Role lacks `WORKFLOW_REQUIRED_PERMISSION[workflow]` | `403 Forbidden` before any state changes. `MAINTAINER` (`*:*`) always passes. |
| Paused protocol | Operator pause | `503 ServiceUnavailable` via `StatusError` translation; no state changes. |
| Replay | Repeated idempotency key | `IDEMPOTENT_CACHE_HIT`, original transaction hash, no double debit. |

`PAYOUT` maps to the public component `settlement`; `REDEMPTION` maps to
`redemption`. The notices are drawn from `DEFAULT_DEGRADED_NOTICES` and pass
through the existing deep secret redaction before reaching the public feed.

## Edge cases

- **Amounts** must be decimal integer strings. Floating strings (`"12.5"`),
  negative values and non-strings are rejected with `400` before state changes.
  Decimal strings avoid the rounding that JSON numbers would cause above
  `Number.MAX_SAFE_INTEGER`.
- **Timestamp boundaries** are checked from epoch `0` to `Date`'s maximum
  representable time (`8.64e15`). `NaN`/`Infinity` and inverted maintenance
  windows are rejected as `invalid_window`; the feed never emits a `NaN` date.
- **Numeric boundaries**: `parseMinorUnits` accepts only bounded base-10
  strings up to `I128_MAX` (`2^127 - 1`), never rounding or throwing; values
  above it are rejected. `toFlexibleNumber` returns a number only when the
  value round-trips, otherwise a string.
- **Hidden records** are never deleted silently. Archiving requires an actor
  and reason, restores keep the full history, and work actions on an archived
  record are refused. `includeArchived=true` is the only way an operator sees
  them on the board; the public feed never does.
- **Search visibility**: `hidden`, `revoked` and `deleted` entries are invisible
  even to their owner; `restricted` requires the viewer address or ownership;
  `private` is owner-only; `public` is open to all.
- **Empty permission sets and unknown roles** are rejected by
  `validateRoleChanges`, so a permission change cannot leave a role unusable.

## Recovery and rollback

- **Automatic**: retryable injected failures are recovered inside the
  simulation; the component is never degraded.
- **Operator recovery**: `POST /resilience/recover/:component` clears the
  component override and resolves the partial failures that caused the
  degradation, attributing the resolution to the actor. The records remain
  queryable with status `resolved`.
- **Hidden records**: `POST /resilience/failures/:id/archive` hides a record
  with attribution; `.../restore` republishes it and keeps the archive in its
  `lifecycle.history`.
- **Permission rollback**: `POST /resilience/permissions/reset` restores the
  built-in role map.
- **Process restart**: all state is in-memory in the existing services; a
  restart returns to the healthy default. This is the safe failure mode — a
  stale "degraded" banner is preferable to silently serving a broken workflow,
  and nothing is persisted that could become inconsistent.

## Contract preservation and migration plan

- No existing route, DTO, event, or database schema changes. The new service
  embeds `StatusReport` verbatim and returns `SimulationResult` verbatim.
- `RESILIENCE_CONTRACT_VERSION` starts at `1`. Bump it (and add a migration note
  here) when adding/removing/renaming a wire-visible field. Adding an optional
  field is backward compatible and does not require a bump.
- Consumers may keep reading `GET /status` and `GET /api/v1/operations/failures`
  unchanged; the slice is additive. `ResilienceModule` is registered in
  `AppModule`, but no endpoint is mounted on the production router by this
  slice — the HTTP surface is demonstrated by the e2e probe controller. To
  expose it later, add a controller in `src/resilience/` mirroring the probe
  and re-run the contract tests.
- Pre-existing compile defects blocked the modules this slice builds on and
  were fixed without behaviour changes:
  - `status-safeguards.ts` used a `.ts` import extension (TS5097).
  - `permission-diff.service.ts` indexed `DEFAULT_ROLES` without an index
    signature (TS7053); the constant is now typed `Record<string, string[]>`.
  - `app.module.ts` had duplicate imports and referenced `RiskModule` without
    importing it.
  - `projects.service.ts` used `ForbiddenException` without importing it. This
    surfaced only when compiling the full `AppModule`; adding `ResilienceModule`
    there did not introduce it.
- `app.module.spec.ts` still cannot compile in this checkout for a separate
  pre-existing reason: the oracle adapters import `oracle/http.ts`, which needs
  `axios` (declared in `oracle/package.json`, not `api/package.json`). That is
  outside this slice's scope and is left unchanged. The slice's own specs build
  a minimal testing module and do not traverse that dependency.
- `package-lock.json` is out of sync with `package.json` (`type-detect`
  missing). `npm install` is required locally; the lock file was deliberately
  not regenerated in this change to avoid an unrelated dependency diff.
