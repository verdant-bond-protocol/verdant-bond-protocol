# Coupon distribution resource budget

Coupon distribution is a resumable state machine. The `PeriodBatchCursor` is
the on-chain checkpoint and advances only after every holder in the requested
range has been processed. A reverted transaction leaves the cursor and all
escrows unchanged, so retrying the same `(bond_id, period_index, offset)` is
safe.

Each call is bounded by `MAX_COUPON_BATCH_SIZE` and an explicit resource
budget. The contract charges a conservative fixed unit for each holder and
rejects a request before doing any external calls when the batch would exceed
the budget. The final batch marks the period distributed and records any dust
as undistributed; earlier batches cannot do either.

The `coupon_batch_checkpoint` event contains `(bond_id, period_index, end,
complete)`. Workers persist the emitted end offset only after transaction
finality, then submit the next offset. A duplicate submission is rejected by
the cursor check, and a failed submission is retried with the same offset and
a fresh nonce. This makes retries idempotent and allows a keeper to resume
after a timeout without replaying holder payouts.
