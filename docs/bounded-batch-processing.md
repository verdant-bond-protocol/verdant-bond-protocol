# Bounded Batch Processing (#526)

`BoundedBatchProcessor` (`api/src/common/batch/bounded-batch-processor.ts`) processes large datasets without unbounded memory growth or unthrottled downstream writes.

## Guarantees
- **Bounded chunk size**: `batchSize` is clamped to `[1, 500]` (`MAX_BOUNDED_BATCH_SIZE`).
- **Bounded run budget**: `maxItems` is capped at `50,000` (`MAX_ITEMS_PER_RUN`), returning `nextCursor` for deterministic resumption.
- **Retry & circuit breaker**: Transient batch failures retry up to `maxRetries` (capped at `3`); permanent failures invoke `onBatchFailureRollback` and abort once `maxFailures` is reached.
- **Authorization**: Only `ADMIN` and `OPERATOR` roles may initiate or resume a batch run.
