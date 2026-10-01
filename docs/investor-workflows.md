# Investor Risk, Dispute, and Covenant Workflows

This document describes the deterministic workflow helpers added for investor-facing risk and settlement controls.

## Counterparty Risk

`CounterpartyRiskService` derives a reproducible `unknown`, `low`, `medium`, or `high` bucket from documented inputs:

- KYC verification state
- covenant breach count
- rejected settlement count
- late-report count
- optional maintainer manual override with a reason

The public summary exposes only the bucket and a human-readable message. Raw scores, input signals, and override reasons stay in the maintainer detail object.

## Settlement Disputes

`SettlementDisputeService` enforces this state policy:

- `open` -> `investigating`, `resolved`, or `rejected`
- `investigating` -> `resolved` or `rejected`
- `resolved` -> `investigating` when new evidence reopens the case
- `rejected` -> `investigating` when new evidence reopens the case

Only one active dispute is allowed for a settlement. Public evidence is visible to users; private evidence remains maintainer-only. Every state transition appends an audit record with actor, action, reason, and timestamp.

## Covenant Breaches

`CovenantBreachService` detects covenant states from:

- missed reporting cadence
- invalid sustainability metrics
- repayment schedule violations

Maintainers can move a detected breach through investigation, accepted remediation, rejected remediation, and resolution. Investor-facing status includes severity, state, and next step without exposing private notes.

## Oracle Scheduler Polling

`OracleScheduler.pollOracleData()` now polls providers configured through:

- `ORACLE_POLL_PROJECT_IDS`: comma-separated project ids
- `DEFAULT_PROVIDER_ADDRESS`: fallback provider address used for every provider
- `ORACLE_PROVIDER_ADDRESSES`: optional JSON object keyed by provider name or methodology

Each provider measurement is validated before submission. The scheduler logs normalized per-provider failures and continues polling the remaining providers.
