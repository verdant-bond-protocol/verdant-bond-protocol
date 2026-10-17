# Pagination, Filtering and Authorization Contract (#402)

`GET /api/oracle/incidents` is the API's paginated, filtered, permission-gated listing.
Contract tests pin its behaviour at two levels:

| Level | Spec | Runs against |
|---|---|---|
| HTTP | `api/src/oracle/oracle-incidents.contract.spec.ts` | The real controller, the `main.ts` `ValidationPipe` options, and the RFC 7807 filter |
| Storage | `api/src/oracle/oracle-incident.repository.spec.ts` (`pagination contract`) | Real, ephemeral PostgreSQL |

## Contract

### Authorization, checked before anything else

| Caller | Result |
|---|---|
| No session | `401`; the store is never queried |
| Session without `MANAGE_INCIDENTS` | `403` (`FORBIDDEN`). An invalid query from this caller is also `403`, not `400`, so validation cannot be used to probe the endpoint |
| `MANAGE_INCIDENTS` (maintainers, settlement managers) | `200` |

### Query

| Parameter | Rule | Default |
|---|---|---|
| `page` | integer, 1–10000 | `1` |
| `limit` | integer, 1–100 | `20` |
| `status` | `active`, `acknowledged` or `resolved` | none (all) |
| `cursor` | `nextCursor` from a previous response | none |

- Values out of range or of the wrong type return an RFC 7807 `400` (`VALIDATION_FAILED`)
  with `errors[]`. The store is not queried.
- Unknown parameters are stripped.

### Response

`{ data, meta }`.

- Ordering is newest detection first: `(last_detected_at DESC, id DESC)`, which is a total
  order.
- In page mode, `meta` contains `{ page, limit, total, totalPages, nextCursor? }`.
- In cursor mode, `meta` contains `{ limit, total, totalPages, nextCursor? }`.
- `total` counts rows matching `status`.
- `nextCursor` is present only when another page exists, in both modes. A client can start
  in page mode and continue with the cursor.

### Errors

- A malformed cursor returns `400` ("Invalid pagination cursor").
- A store failure returns a generic `500` (`INTERNAL_ERROR`) that leaks no internals.

## What was fixed

1. **The endpoint could not load.** `findMany` declared `queryParams` twice, which is both a
   compile error and a runtime `SyntaxError`, so `OracleModule` and everything importing the
   repository could not load.
2. **Rows were skipped or repeated.** Ordering was by `last_detected_at` alone. One cron
   cycle stamps every subject it detects with the same time, so ties are the norm:
   - offset pages could repeat or skip tied rows;
   - the timestamp-only cursor (`last_detected_at < cursor`) skipped every row tied with the
     cursor.

   Paging is now keyset-based on `(last_detected_at, id)`, using PostgreSQL row-value
   comparison, which is lexicographic. It is backed by the new index
   `oracle_incidents_recency_idx`.
3. **Cursor mode could not be started.** Page-mode responses never returned `nextCursor`.
4. **A bad cursor was a server fault.** A malformed cursor threw a `RangeError`, which
   surfaced as a `500`.

## Retry and consistency

- Reads are pure, so a failed request can simply be retried.
- A cursor page is stable: rows that arrive later (newer detections) sort before the
  cursor, so retrying a cursor request returns the same rows.
- Offset pages can shift when rows are inserted between requests. For a consistent walk,
  page once and then follow `nextCursor`.
- Cursors are not signed. A forged cursor can only reposition a scan that the caller is
  already authorised to perform.

## Compatibility and migration

- **Response shape:** unchanged, apart from the added `nextCursor` in page mode.
- **Cursor format:** now `<ISO time>|<incident id>` and should be treated as opaque. Legacy
  bare-timestamp cursors are still accepted (strictly older rows), so clients holding one
  keep working.
- **Index:** `CREATE INDEX IF NOT EXISTS` runs at module start, like the table's existing
  DDL. A non-concurrent build blocks inserts, updates and deletes on `oracle_incidents`
  (reads still work) until the build finishes. On a large table, first run
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS oracle_incidents_recency_idx ON oracle_incidents (last_detected_at DESC, id DESC);`
  by hand. The startup statement then finds the index and skips it.
- **Rollback:** revert the repository change. The extra index is harmless and can be
  dropped with `DROP INDEX oracle_incidents_recency_idx`.

## Complexity

- Page mode scans O(offset + limit) rows.
- Cursor mode is O(log n + limit) through the index.
- `total` is a `COUNT(*)` filtered by status: O(n), or O(matching) via `oracle_incidents_status_idx`.
