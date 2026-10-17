# Audit Evidence for Administrative Configuration Changes (#408)

Runtime policy configuration includes:

- subscription minimum and maximum amounts;
- the maximum total holding;
- restricted jurisdictions;
- the redemption penalty;
- the redemption and maturity windows.

These settings decide who can invest and how much. Before #408 they could only be changed
in memory (`PolicyService.updatePolicyConfiguration`), with no record of who changed what,
or why.

Every change now goes through `PolicyConfigChangeService`. It leaves tamper-evident
evidence in the existing hash-chained audit trail, under entity `admin-config/policy`.

## API

| Method | Path | Guards | Purpose |
|---|---|---|---|
| `GET` | `/api/admin/config/policy` | JWT, admin | Current configuration (amounts as integer strings) |
| `PUT` | `/api/admin/config/policy` | JWT, admin, signed intent `update_policy_config` | Apply a change |
| `POST` | `/api/admin/config/policy/rollback` | JWT, admin, signed intent `rollback_policy_config` | Undo an applied change |

Evidence is read through the existing audit endpoints:

- `GET /api/api/v1/audit/history/admin-config/policy`
- `GET /api/api/v1/audit/verify/admin-config/policy`
- `GET /api/api/v1/audit/evidence/admin-config/policy?caseId=…`, which returns a redacted,
  verifiable bundle.

The doubled `api` is real. `AuditController` is declared as `api/v1/audit` and `main.ts`
also sets the global prefix `api`. Nest applies the global prefix to every route, and a
probe confirms `/api/v1/audit/*` returns 404 while `/api/api/v1/audit/*` serves. That
quirk predates #408 and is left unchanged here.

Request body for `PUT`:

```json
{
  "changeId": "chg-2026-10-17-01",
  "reason": "Lower ticket size for retail tranche",
  "updates": {
    "maxSubscriptionAmount": "500000",
    "restrictedJurisdictions": ["KP", "IR"]
  }
}
```

Field rules:

- **Amounts:** `minSubscriptionAmount`, `maxSubscriptionAmount` and `maxTotalHoldings` are
  non-negative integer strings. Strings keep values exact beyond 2^53.
- **Penalty and windows:** `redeemptionPenaltyPercentage` (at most 100),
  `earlyRedemptionMinDaysRemaining` and `maturityWarningDays` are non-negative numbers.
- **Jurisdictions:** `restrictedJurisdictions` holds letter-only codes. They are
  upper-cased, de-duplicated and sorted.
- **Cross-field:** `min` may not exceed `max`.
- **Unknown settings** are rejected.

## What each path records

| Path | Configuration | Audit entry |
|---|---|---|
| **Applied** | Changed after the evidence is written | `policy.config.updated`: actor (the authenticated wallet), reason, `changeId`, `changedKeys`, full `before` and `after` snapshots |
| **No-op** (values already set) | Unchanged | none; the outcome is `unchanged` |
| **Rejected** (validation) by an admin | Unchanged | `policy.config.rejected`: actor, reason, error and the attempted body |
| **Evidence cannot be written** (audit chain at capacity) | **Unchanged**, with a 503 response | none. No evidence means no change |
| **Unauthorized** (not admin, or no valid intent) | Unchanged; the guards reject the request before the service runs | none. The request is visible only in request logs |
| **Retry**, same `changeId` and body | Not re-applied | none; the original outcome is returned |
| **Same `changeId`, different body** | Unchanged, with a 409 response | none |
| **Rollback** | Only the keys the target changed are restored | `policy.config.rolled_back`, with `rolledBack: <targetChangeId>` |

The actor always comes from the authenticated session. A client-supplied `actor` is
stripped.

Changes are serialised, so each entry's `before` snapshot is exactly the state that change
replaced.

## Rollback and recovery

- **Undo a change:** call `POST /api/admin/config/policy/rollback` with
  `{ changeId, reason, targetChangeId }`.
  - Only the keys the target changed are restored to their recorded values. Later,
    unrelated changes stay.
  - The rollback is a new, evidenced entry; the audit history is never rewritten.
  - Retrying with the same `changeId` is safe.
- **What can be rolled back:** only applied changes (`updated` or `rolled_back`) are
  targets. Rejected attempts or unknown ids return 404.
- **Tampered evidence:** rollback first verifies the chain. If verification fails, it
  refuses with a 409, because the recorded snapshots cannot be trusted. Investigate with
  `GET /api/api/v1/audit/verify/admin-config/policy`.
- **Process restart:** the configuration reloads from `POLICY_CONFIG` (environment), as
  before. Changes made at runtime are not persisted. After a restart, re-apply them from
  the recorded `after` snapshots, or update `POLICY_CONFIG`.
- **Retry window:** idempotent replay remembers the last 5,000 change ids, evicting the
  oldest first. After a restart, a retried `changeId` is evaluated as a new request.

## Edge cases

- **Correcting a rejected request:** a rejected request may be fixed and resent with the
  same `changeId`, because rejections are not remembered as outcomes. Each failed attempt
  stays in the evidence.
- **Audit chain capacity:** the chain holds 5,000 entries per entity and 10,000 in total
  (`GET /api/api/v1/audit/stats`). At either cap, configuration changes are refused, not
  applied without evidence.
- **Durability of the evidence:** the in-memory audit chain is the evidence store, as it is
  for every other audited record. Its durability is that of `AuditService`
  (`api/docs/AUDIT_HISTORY.md`).

## Compatibility

- **Additive changes only:** three new routes, one new service, and `PolicyModule` now
  imported by `AppModule`. It was previously defined but not registered.
- **Unchanged contracts:** `PolicyService`'s public methods are unchanged. The audit API
  and record format are unchanged.
- **Migration:** none needed.
