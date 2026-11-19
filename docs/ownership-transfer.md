# Ownership Transfer with Expiry and Audit History (#542)

`OwnershipTransferService` (`api/src/ownership/ownership-transfer.service.ts`) implements two-step ownership handoffs with bounded TTLs and an append-only audit trail.

## Guarantees & Edge Cases
- **Two-step handoff**: Ownership changes only upon `accept(transferId, nomineeId)` before `expiresAt`.
- **Expiry**: Expired transfers transition to `EXPIRED`, record an `EXPIRED` audit entry, and cannot be accepted.
- **Retry & Cancellation**: Owners can `cancel` a pending transfer or `retry` an `EXPIRED`/`CANCELLED` transfer to issue a fresh `PENDING` transfer.
- **Authorization**: Only the current owner can `initiate`, `cancel`, or `retry`; only the designated nominee can `accept`.
