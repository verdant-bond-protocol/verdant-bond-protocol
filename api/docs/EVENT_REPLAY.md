# Versioned event replay for derived projections

A projection is a read model derived from an append-only event log.
`src/projections/event-replay.ts` rebuilds or resumes one deterministically and
fails safe when the log or the code has moved on. The behaviour is covered by
`src/projections/event-replay.spec.ts`.

## Concepts

| Term | Meaning |
|---|---|
| Event | `{ id, aggregateId, sequence, type, schemaVersion, occurredAt, payload }`. `sequence` is 1-based and contiguous per aggregate. |
| Upcaster | A pure function that lifts a payload by exactly one `schemaVersion`. Registered per `type@fromVersion`. |
| Projection | `{ name, version, initial, handlers }`. Handlers are pure reducers keyed by event type and always see the current event shape. |
| Snapshot | Per-aggregate state, the last applied sequence per aggregate, the projection name and version, and a SHA-256 digest of those. |

## Normal path

1. Events are grouped per aggregate and ordered by `sequence`, so arrival order
   does not matter. Aggregates are processed in sorted id order, so the same
   log always gives the same snapshot digest.
2. Each event is upcast to the current schema, then passed to its handler with
   a copy of the state (a handler can never leave a half-mutated state behind).
3. Event types with no handler are counted as `ignored`; the position still
   advances, so the sequence stays contiguous.

## Failure paths

Problems in the data return `status: 'failed'` with the checkpoint reached
before the failing event and a `failure` describing it. Nothing past the
failure is applied.

| Code | Cause | Recovery |
|---|---|---|
| `invalid_event` | Missing id, aggregate, type, or a non-positive sequence or schema version; unknown event type | Fix or quarantine the event, then resume |
| `unknown_version` | Event is newer than the code, or an upcaster step is missing | Deploy the newer code or add the upcaster, then resume |
| `sequence_gap` | Expected sequence N, found a later one | Backfill the missing events, then resume |
| `conflicting_duplicate` | Two different events claim the same aggregate and sequence in one replay | Investigate the log; this should never happen |
| `handler_failed` | The handler threw on every attempt (`maxAttempts`, default 3) | Fix the handler, then resume |

An exact repeat of an event (same id and content) is **not** an error: it is
skipped and counted in `duplicates`. This also covers resuming over events that
a checkpoint already includes.

Caller mistakes throw `EventReplayError` instead: `forbidden`,
`checkpoint_mismatch`, `invalid`.

## Retry and resume

- A throwing handler is retried up to `maxAttempts` against the same input state.
  A handler that returns `undefined` is treated as a failure.
- After a failure, fix the cause and call `replay` with `mode: 'resume'` and the
  failed result's `snapshot`. Already-applied events are skipped.
- `ProjectionStore.resume` keeps the checkpoint even when the replay halts, so
  progress is never thrown away.

## Changing a projection (migration and rollback)

Bump `version` whenever a projection's logic or state shape changes.

- A snapshot taken under another version, or one whose digest does not match its
  contents, **cannot be resumed**: `replay` throws `checkpoint_mismatch`. Rebuild
  from the log instead.
- `ProjectionStore.rebuild` replays from scratch into a staging snapshot. The
  live snapshot is replaced only if the whole replay completes; a failed rebuild
  leaves it untouched.
- After a successful rebuild the previous snapshot is kept, and
  `ProjectionStore.rollback` restores it. Only one level is kept; a second
  rollback in a row fails.
- Changing an event's shape: raise its current version in the
  `UpcasterRegistry` and register an upcaster from the old version. Stored events
  are never rewritten; upcasting works on a copy.

## Authorization

`replay`, `ProjectionStore.resume`, `rebuild` and `rollback` require an actor with
`isAdmin: true`. Anything else throws `forbidden` before any state is read or
changed.

## Not covered here

- Snapshots and the event log are passed in by the caller. This module has no
  persistence, scheduling or HTTP endpoint; wiring those is a separate change.
- Duplicate detection across separate replays relies on the snapshot's positions
  (a sequence at or below the position is skipped). Content conflicts are
  detected only within the events of a single call.
- Events and state must be JSON-serialisable (they are copied through JSON).
