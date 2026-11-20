# Notification Preference & Mandatory-Alert Routing

> Issue #384 — Durable notification preference and mandatory-alert routing model.

## Overview

The notification system enforces a two-tier delivery model:

| Tier | Categories | User-controllable |
|------|-----------|-------------------|
| **Mandatory** | `compliance`, `security`, `settlement_failure` | ❌ Never suppressed |
| **Optional** | `bond_updates`, `coupon_updates`, `project_reports` | ✅ Per-user opt-in/out |

Every delivery decision (delivered or suppressed) is written to
`notification_decisions` so operators can audit the full routing history.

Every preference change is written to `notification_preference_history` so
operators can see exactly when a user opted out, why, and what changed.

## Routing Logic

```
createNotification(type, userId)
  └─ TYPE_CATEGORY[type]  →  category
       ├─ mandatory category?  →  always deliver, record decision (mandatory=true)
       └─ optional category?   →  check getPreferences(userId)[category]
            ├─ true   →  deliver, record decision (delivered=true)
            └─ false  →  suppress, record decision (delivered=false)
```

Unrecognised types fall back to `bond_updates` (optional) — they are
suppressed if the user has opted out of that category.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/notifications/preferences` | Current optional prefs + mandatory list |
| `PATCH` | `/notifications/preferences` | Update optional prefs (body: `{ bond_updates: false }`) |
| `GET` | `/notifications/preferences/history` | Durable change log, newest first |
| `GET` | `/notifications/decisions` | Per-event delivery decisions (audit trail) |

## Failure Modes & Edge Cases

### DB write failure on preference history
The preference is updated in memory and in `notification_preferences` before
the history row is written.  If `notification_preference_history` write fails,
the change is still applied and the error is logged at `ERROR` level.  The
history entry will be missing but the preference is correct.

**Recovery**: Re-apply the preference change to regenerate the history row.

### DB write failure on notification_decisions
Failures are caught and logged.  The in-memory `decisions` array is always
updated, so `getDecisions()` returns accurate data for the lifetime of the
process.  On restart, decisions from before the failure window may be absent.

**Recovery**: Cross-reference with application logs; the logger emits the
decision fields before the DB write.

### Mandatory category override attempts
Attempts to call `setPreferences` with a mandatory category key throw
`BadRequestException` before any write occurs.  No history entry is created.

## Rollback Steps

If a bad preference update is applied:
1. Call `PATCH /notifications/preferences` with the correct values.
2. Verify via `GET /notifications/preferences/history` that the correction
   is recorded.
3. No DB rollback is required — the history table is append-only.
