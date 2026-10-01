/**
 * Explicit record lifecycle: archive and restore.
 *
 * A record is never *soft-deleted* through a bespoke boolean and never hidden
 * by a status value that only one reader knows to filter. Anything a reader
 * should not see is **archived**: an explicit, attributed, reversible
 * transition that carries who did it, when, and why, and that every read path
 * filters through the same `isArchived` predicate.
 *
 * The rules this module enforces, so they cannot be re-derived per service:
 *
 * 1. **Archiving requires a reason.** A record that disappears from a board
 *    without a written justification is a bug, not a moderation action.
 * 2. **Archiving requires an actor.** Service-initiated transitions name a
 *    `system:<name>` principal rather than an anonymous write.
 * 3. **Restore is a first-class operation, not a flag reset.** It clears the
 *    attribution of the archive it reverses but keeps the archive in
 *    `history`, so a record that was archived and restored is visibly
 *    different from one that never was.
 * 4. **Transitions are not idempotent-silent.** Archiving an archived record
 *    or restoring an active one throws, rather than quietly succeeding and
 *    leaving the caller believing something changed.
 * 5. **Visibility is derived, never stored separately.** `isArchived` is the
 *    only thing that decides whether a record is visible; there is no second
 *    "hidden" flag that can disagree with it.
 *
 * Domain status (`open`/`resolved`, `scheduled`/`completed`) is orthogonal and
 * stays on the record. Archiving is the lifecycle; status is the work.
 */

/** The two lifecycle states. There is no third, and no free-form flag. */
export enum ArchiveState {
  Active = 'active',
  Archived = 'archived',
}

export type ArchiveAction = 'archive' | 'restore';

export interface ArchiveEvent {
  at: string;
  action: ArchiveAction;
  /** Wallet address of the operator, or a `system:<name>` principal. */
  actor: string;
  /** Required on archive, absent on restore. */
  reason?: string;
}

export interface RecordLifecycle {
  state: ArchiveState;
  /** ISO timestamp of the current (or most recent) archive. */
  archivedAt: string | null;
  archivedBy: string | null;
  /** The justification for the current (or most recent) archive. */
  archiveReason: string | null;
  /** ISO timestamp of the most recent restore, if any. */
  restoredAt: string | null;
  restoredBy: string | null;
  /**
   * Every archive/restore this record has been through, oldest first.
   * Append-only: a restore never erases the archive it reverses.
   */
  history: ArchiveEvent[];
}

export type LifecycleErrorCode =
  | 'already_archived'
  | 'not_archived'
  | 'missing_actor'
  | 'missing_reason'
  /** The record is archived, so a work action on it is not allowed. */
  | 'archived';

export class LifecycleError extends Error {
  constructor(
    message: string,
    public readonly code: LifecycleErrorCode,
  ) {
    super(message);
    this.name = 'LifecycleError';
  }
}

export interface TransitionInput {
  /** Wallet address, or a `system:<name>` principal for service-initiated work. */
  actor: string;
  /** Mandatory for archive, ignored for restore. */
  reason?: string;
  now?: number;
}

/** Anything that carries a lifecycle and can therefore be archived. */
export interface Archivable {
  lifecycle: RecordLifecycle;
  /** Used only to name the record in a refusal message. */
  id?: string;
}

/** A fresh, active lifecycle for a newly created record. */
export function activeLifecycle(): RecordLifecycle {
  return {
    state: ArchiveState.Active,
    archivedAt: null,
    archivedBy: null,
    archiveReason: null,
    restoredAt: null,
    restoredBy: null,
    history: [],
  };
}

/**
 * The single visibility predicate. Every read path that omits archived
 * records calls this (usually via `visibleOnly`).
 */
export function isArchived(record: Archivable): boolean {
  return record.lifecycle?.state === ArchiveState.Archived;
}

function requireActor(actor: string): string {
  const trimmed = actor?.trim();
  if (!trimmed) {
    throw new LifecycleError('an actor is required to change a record lifecycle', 'missing_actor');
  }
  return trimmed;
}

/**
 * Archive a record. Throws if it is already archived — re-archiving would
 * overwrite the original actor, timestamp and reason with no trace.
 */
export function archiveRecord(lifecycle: RecordLifecycle, input: TransitionInput): RecordLifecycle {
  const actor = requireActor(input.actor);
  const reason = input.reason?.trim();
  if (!reason) {
    throw new LifecycleError('a reason is required to archive a record', 'missing_reason');
  }
  if (lifecycle.state === ArchiveState.Archived) {
    throw new LifecycleError('record is already archived', 'already_archived');
  }

  const at = new Date(input.now ?? Date.now()).toISOString();
  lifecycle.state = ArchiveState.Archived;
  lifecycle.archivedAt = at;
  lifecycle.archivedBy = actor;
  lifecycle.archiveReason = reason;
  // A restore is a transition of its own; the next archive starts a new one.
  lifecycle.restoredAt = null;
  lifecycle.restoredBy = null;
  lifecycle.history.push({ at, action: 'archive', actor, reason });
  return lifecycle;
}

/**
 * Restore a previously archived record. Throws if it is not archived. The
 * archive stays in `history` and `archivedBy`/`archiveReason` keep the last
 * attribution, so "archived then restored" is distinguishable from "never
 * archived" without a second flag.
 */
export function restoreRecord(lifecycle: RecordLifecycle, input: TransitionInput): RecordLifecycle {
  const actor = requireActor(input.actor);
  if (lifecycle.state !== ArchiveState.Archived) {
    throw new LifecycleError('record is not archived', 'not_archived');
  }

  const at = new Date(input.now ?? Date.now()).toISOString();
  lifecycle.state = ArchiveState.Active;
  lifecycle.restoredAt = at;
  lifecycle.restoredBy = actor;
  lifecycle.history.push({ at, action: 'restore', actor });
  return lifecycle;
}

/** Drop archived records. The default shape of any public read path. */
export function visibleOnly<T extends Archivable>(records: readonly T[]): T[] {
  return records.filter((record) => !isArchived(record));
}

/**
 * Records a read path may return. `includeArchived` is opt-in and, when set,
 * callers are expected to surface the record's `lifecycle` alongside it so an
 * archived record is never rendered as if it were live.
 */
export function includeArchived<T extends Archivable>(
  records: readonly T[],
  include: boolean,
): T[] {
  return include ? [...records] : visibleOnly(records);
}

/** A read path acting on a record: refuses to touch one that is archived. */
export function assertNotArchived(record: Archivable, action: string): void {
  if (isArchived(record)) {
    throw new LifecycleError(
      `${recordKey(record)} is archived; restore it before ${action}`,
      'archived',
    );
  }
}

function recordKey(record: Archivable): string {
  return String(record.id ?? 'record');
}

/** Build a `system:<name>` principal for a service-initiated transition. */
export function systemActor(name: string): string {
  return `system:${name.trim() || 'unknown'}`;
}
