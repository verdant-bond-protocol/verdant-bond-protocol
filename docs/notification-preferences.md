# Participant notification preferences

The authenticated wallet can read `GET /notifications/preferences` and update
optional categories with `PATCH /notifications/preferences`, for example
`{"bond_updates":false}`. Omitted categories keep their current value; all
optional categories default to enabled. The body accepts only boolean values
for `bond_updates`, `coupon_updates`, and `project_reports`. It cannot name a
different wallet or edit mandatory categories.

`compliance`, `security`, and `settlement_failure` are mandatory. The existing
`RECOVERY_INTERRUPTED` and `PARTIAL_FAILURE` events map to settlement failure.
Known bond, coupon, and project report events map to their optional categories.
Unknown event types default to `bond_updates` so an unclassified new event
cannot silently bypass an opt-out. Add new critical event types to the fixed
mapping before emitting them.

Every delivery attempt records its category and whether it was delivered at
`GET /notifications/decisions`. Mandatory alerts always enter the inbox even
when every optional category is disabled. The existing `(userId, eventId)`
deduplication still applies to delivered alerts.

With `DATABASE_URL` configured, the service creates `notification_preferences`
and `notification_decisions` tables on startup. Preferences and decision records
survive API restarts; notifications themselves retain the existing in-memory
inbox lifecycle. Without a database, preferences and decisions are process
local, intended for tests and development only. Deployments must provision
PostgreSQL through the existing `DATABASE_URL` setting. No data backfill is
needed; existing participants use the enabled defaults.

Validation: `cd api && npm test -- --runInBand notifications.service.spec.ts`.
