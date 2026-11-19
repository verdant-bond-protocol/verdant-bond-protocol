# Partial Settlement Recovery for Interrupted Bond Transfers (#441)

`PartialSettlementRecoveryService` (`api/src/bonds/partial-settlement-recovery.service.ts`) prevents split-brain financial state when a multi-leg bond transfer fails mid-flight.

## Invariants & Recovery
- **Conservation of bond supply**: If any leg fails, all previously committed legs in that attempt are compensated in reverse (LIFO) order.
- **Idempotent retry**: Re-running `executeOrRecover` with the same `settlementId` after recovery re-executes cleanly; once `COMPLETED`, subsequent calls are no-ops.
- **Authorization**: Only `ADMIN` and `SETTLEMENT_MANAGER` roles may execute or recover settlements.
