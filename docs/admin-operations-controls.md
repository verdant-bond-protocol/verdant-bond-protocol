# Admin Operations Controls

This document describes the maintainer-facing controls for high-impact operations.

## Signed Approvals

`AdminOperationsService` verifies approval metadata before a protected action executes:

- action id
- actor id
- reason
- expiry timestamp
- nonce
- signature

The verification rejects missing or mismatched action metadata, expired approvals, wrong actors, invalid signatures, and replayed nonces.

## Freeze Windows

Freeze windows block configured actions during audits, settlement windows, or incident response.

- `scope` can target a single action or `*` for all protected actions.
- expired and future windows do not block actions.
- emergency bypass is allowed only for actors listed on the active freeze window.

## Anomaly Reports

The anomaly report is read-only and highlights:

- volume spikes by resource
- repeated failed operations by actor
- suspicious actors touching many resources in a sample

Maintainers should triage high-severity volume spikes first, then repeated failures, then low-severity suspicious-actor findings. A finding is a prompt for review, not an automatic enforcement decision.

## Marketplace Sell UX

The marketplace sell screen now handles `getHeldBonds()` failures with a dismissible error banner, renders an explicit empty state for wallets with no bond tranches, and prevents list submissions unless the selected bond exists in the wallet's held-bond set.
