# Operator Resilience: Failures, Cancellation, Delivery Receipts, Input Limits

This note covers four related pieces of the API (#535, #536, #539, #540). Each one
is a self-contained module with its own tests. None of them changes an existing
contract.

## Operator dashboard for unresolved partial failures (#535)

`GET /api/v1/operations/failures/unresolved` is admin-only (`JwtAuthGuard` + `AdminGuard`).
It is built by `buildOperatorDashboard` in `src/failures/operator-dashboard.ts`.

- **What is included:** live failures whose status is `open` or `retrying`. Resolved
  and archived records are left out of the queue.
- **Order:** severity first (critical, then warning, then info), then stale before
  fresh, then oldest first, then `id` as a tie-break.
- **Retry budget:** once `retryCount` reaches `maxRetries` (default 5), or when the
  failure is not retryable, the row is marked `needsManualRemediation` and the
  `retry` action is no longer offered.
- **Query params:** `staleAfterMs`, `maxRetries`, `limit`. `limit` only trims the
  rows; the totals always count every unresolved failure.
- **Recovery:** use the existing `resolve`, `archive` and `restore` endpoints.
  Archiving can be undone with `restore`.

## Safe cancellation and cleanup for long-running jobs (#536)

`CancellableJobRunner` is in `src/workers/services/cancellable-job.runner.ts` and
is built on `OperationCancellationService`.

- **When cancellation takes effect:** only between steps, so a step is never cut
  off halfway through. A cancel that arrives during the last step still applies.
- **Cleanup:** on cancel, timeout or failure, the `cleanup` handlers of the steps
  that finished run in reverse order. If one cleanup throws, the error is recorded
  in `cleanupErrors` and the remaining cleanups still run.
- **Retry or resume:** pass `completedSteps` back in as `resumeFrom` to skip work
  that is already done. Steps that were rolled back are removed from
  `completedSteps`, so they run again on the next attempt. Set
  `cleanupOnFailure: false` to keep the progress after a transient failure instead
  of rolling it back.
- **Who can cancel:** the job owner or an admin. Anyone else gets
  `JobCancellationForbiddenError`. Cancelling a job that is unknown or already
  cancelled returns `false`.
- **Registry entry:** it is always released when the job ends, so the same id can
  be started again.

## Notification deduplication with delivery receipts (#539)

`DeliveryReceiptLedger` is in `src/notifications/delivery-receipts.ts`.

- **Dedupe key:** `(userId, eventId, channel)`. If a delivery for that key is
  pending or already delivered, the new attempt is suppressed.
- **Retries:** a failed delivery is retried up to `maxAttempts` times. After that
  it moves to `dead_lettered` and further attempts are refused.
- **Stuck deliveries:** a pending claim older than `pendingTimeoutMs` (for example,
  after a worker crash) is marked failed and can be retried.
- **Confirmation:** `confirm` is idempotent for the same provider receipt id. A
  different receipt id for an already delivered notification is rejected as a
  `conflict`.
- **Who can read receipts:** the recipient or an admin.
- This sits on top of the existing decision-level dedupe in
  `NotificationsService`, which is unchanged.

## Strict input size and cardinality limits (#540)

`checkInputLimits`, `assertInputLimits` and `InputLimitsPipe` are in
`src/common/validation/input-limits.ts`.

| Limit | Default |
| --- | --- |
| total bytes (UTF-8 JSON) | 256 KiB |
| nesting depth | 12 |
| string / key length | 16 KiB |
| array length | 1000 |
| object keys | 200 |
| total nodes | 20000 |

- **Order of checks:** total bytes, then depth, string length, array length, key
  count and total node count. The first limit that fails is the one reported.
- **Error response:** a 400 with `error: input_limit_exceeded` and a `violation`
  object that gives the JSON path and the limit that was hit.
- **Deep payloads:** the walk over the body is iterative, so very deeply nested
  input cannot overflow the stack.
- **Adoption:** this is opt-in per route, for example
  `@Body(new InputLimitsPipe({ maxArrayLength: 100 }))`. No existing route changes
  behaviour until it adds the pipe.
