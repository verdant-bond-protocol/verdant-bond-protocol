# Lifecycle compliance snapshots

The API captures a compliance snapshot after confirmed bond issuance,
subscription, coupon distribution, and maturity. Each snapshot includes the
event's identifiers and relevant event data, a copy of the active compliance
ruleset, a UTC capture time, schema version `1`, and a SHA-256 hash over the
canonical JSON of those fields. It intentionally stores the attestation
payload for subscriptions without its signature or private keys.

Event keys are stable: `bond:<id>:issued`,
`bond:<id>:subscription:<transactionHash>`,
`bond:<id>:coupon:<periodIndex>`, and `bond:<id>:matured`. PostgreSQL enforces
one row per key; repeat captures return the original row. A database trigger
rejects updates and deletes. The service checks the hash on demand, so a
reviewer can detect altered content even if a privileged database operator
bypasses the trigger.

An authenticated admin can request
`GET /api/v1/compliance/snapshots/<eventId>`. The response includes
`integrityValid`, calculated from the stored fields. A missing key returns
404. Other wallets cannot read snapshots.

Deployment uses the existing `DATABASE_URL`; startup creates the
`compliance_snapshots` table, index, and immutability trigger. No historical
backfill is implied: snapshots begin with events processed after deployment.
Without PostgreSQL, snapshots are process local for development and tests.
Post-settlement database failures surface to the caller even though the
Stellar transaction may have succeeded; operators should reconcile the
transaction and retry capture using the same event key rather than submit a
new transaction.

Validation: `cd api && npm test -- --runInBand compliance-snapshot.service.spec.ts compliance.controller.spec.ts`.
