# Safe cancellation for long-running imports and exports

Issue: [#404](https://github.com/verdant-bond-protocol/verdant-bond-protocol/issues/404)

Long-running imports and exports can be cancelled safely and cooperatively. A
cancel request never tears a unit of work in half; it is observed **between
chunks**, so the operation stops at a consistent boundary and reports the work
it already completed.

## Shared primitive

`OperationCancellationService` (`api/src/common/services/operation-cancellation.service.ts`,
provided globally by `CommonModule`) is the cooperative cancellation registry:

```ts
const token = cancellation.start(operationId, 'import');
// ... in the work loop, at a safe point:
token.throwIfCancelled();          // throws OperationCancelledError
token.signal;                      // standard AbortSignal for I/O
```

- `start(id)` is idempotent for a live operation, so a second `start` cannot
  drop a pending cancel. Starting a **cancelled** id supersedes it — that is the
  retry path.
- `cancel(id, reason)` returns `true` only when it actually flipped a live
  operation, making the control path idempotent.
- Cancelling an unknown or already-finished operation is a safe no-op.

## Imports

`ImportsModule` exposes the import surface:

| Method | Path                              | Auth | Purpose                              |
| ------ | --------------------------------- | ---- | ------------------------------------ |
| `POST` | `/api/v1/imports`                 | JWT  | Start an import.                     |
| `GET`  | `/api/v1/imports`                 | JWT  | List import operations.              |
| `GET`  | `/api/v1/imports/:operationId`    | JWT  | Operation status + partial result.   |
| `POST` | `/api/v1/imports/:operationId/cancel` | JWT | Cancel a running import.         |
| `POST` | `/api/v1/imports/:operationId/retry`  | JWT | Retry a cancelled/failed import. |

`BulkImportService.runImport` validates rows and processes them in chunks
(default 100, configurable via `chunkSize`), yielding to the event loop between
chunks so cancellation is observed promptly. On cancellation it returns the
partial `ImportResult` plus `cancelled: true` and the number of rows already
decided.

### Authorization

Only the owner of an import or an actor with the `ADMIN` role may cancel or
retry it; anything else is a `403`. Unknown operation ids are `404`. Starting
an empty import is `400`.

## Exports

Export cancellation already exists (`ExportService.cancelExport`,
`isExportCancelled`, and the `AbortSignal` threaded through
`ExportStreamPipeline`) with its own owner-or-admin authorization. It is the
export-side counterpart of the same contract and is covered by
`api/src/exports/services/export.service.spec.ts`.

## Failure, retry, and rollback

- **Normal** — the operation runs to completion and reports `completed`.
- **Failure** — invalid rows are counted in `result.errors`; the operation
  still completes so the caller can act on the per-row detail.
- **Retry** — a `cancelled`/`failed` operation can be retried; already-completed
  operations are a no-op. Attempts are tracked.
- **Rollback** — cancellation is in-memory and additive; no persisted import
  state is mutated by cancelling, so disabling the feature has no rollback
  surface.

## Testing

- `api/src/common/services/operation-cancellation.service.spec.ts`
- `api/src/imports/imports.service.spec.ts`

Both cover the normal, failure, retry, authorization, idempotency, and
unknown-operation paths.
