/**
 * Operator-safe backfill framework (see docs/BACKFILL.md).
 *
 * A backfill walks every record a job owns in a stable key order, asks the job
 * what (if anything) should change, and either reports the diff (dry-run, the
 * default) or applies it in batches. Applying is made safe by three things:
 *
 *  - a checkpoint saved after every committed batch, so an interrupted run
 *    resumes after the last committed key instead of starting over;
 *  - a write-ahead journal of before/after images, written before each batch
 *    is committed, so a run can be rolled back record by record;
 *  - a lock file, so two operators cannot run the same job at once.
 *
 * Jobs stay framework-free (no Nest DI) so the CLI can run them against a
 * stopped service.
 */

export type BackfillMode = 'dry-run' | 'apply';

/** What a job wants to do with one record. */
export type BackfillDecision<R> =
  | { action: 'update'; after: R; changes: string[] }
  | { action: 'noop' }
  | { action: 'skip'; reason: string };

export interface BackfillJob<R> {
  /** Stable id; names the checkpoint, lock and journal files. */
  readonly id: string;
  /**
   * Bump whenever `plan` logic changes. A checkpoint written by another
   * version is refused on resume, since its cursor no longer means the same.
   */
  readonly version: number;
  readonly description: string;
  /** Recovery note shown in every report. */
  readonly rollback: string;
  /** Called once before a run. */
  open(): Promise<void>;
  /** Every key the job owns, in a stable, sortable order. */
  listKeys(): Promise<string[]>;
  load(key: string): Promise<R | null>;
  /** Pure: decide what to do. Throwing marks the record failed. */
  plan(key: string, record: R): BackfillDecision<R>;
  /** Persist a batch atomically: all of it or none of it. */
  commit(changes: BackfillChange<R>[]): Promise<void>;
  /**
   * Put before-images back. Must leave a record alone (and report it as a
   * conflict) when its current value is no longer the journalled after-image.
   */
  restore(changes: BackfillChange<R>[]): Promise<BackfillRestoreResult>;
}

export interface BackfillChange<R> {
  key: string;
  before: R;
  after: R;
}

export interface BackfillRestoreResult {
  restored: string[];
  conflicts: Array<{ key: string; reason: string }>;
}

export interface BackfillDiffEntry {
  key: string;
  /** Field-level description, e.g. `expiresAt: <missing> → null`. */
  changes: string[];
}

export interface BackfillSkippedEntry {
  key: string;
  reason: string;
}

export interface BackfillFailedEntry {
  key: string;
  error: string;
  attempts: number;
}

export type BackfillRunStatus =
  | 'running'
  | 'interrupted'
  | 'aborted'
  | 'completed'
  | 'rolled-back';

export interface BackfillCounters {
  scanned: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export interface BackfillCheckpoint {
  jobId: string;
  jobVersion: number;
  /** Hash of job id, version and run parameters; must match on resume. */
  fingerprint: string;
  runId: string;
  status: BackfillRunStatus;
  /** Last key whose batch was committed. Resume starts after it. */
  cursor: string | null;
  counters: BackfillCounters;
  skipped: BackfillSkippedEntry[];
  failed: BackfillFailedEntry[];
  /** Set on a `--retry-failed` run: the run whose failures it reprocesses. */
  retryOf?: string;
  /** Explicit key set for a `--retry-failed` run, so it can itself resume. */
  keySet?: string[];
  startedAt: string;
  updatedAt: string;
  /** Why the run stopped, when it did not complete. */
  error?: string;
}

export interface BackfillOptions {
  mode: BackfillMode;
  batchSize?: number;
  /** Stop after this many records (canary runs). */
  limit?: number;
  /** Abort once this many records have failed. */
  maxFailures?: number;
  /** Attempts per batch commit before the run aborts. */
  maxCommitAttempts?: number;
  /** Continue a checkpointed run instead of refusing. */
  resume?: boolean;
  /** Discard an unfinished checkpoint and start again from the first key. */
  restart?: boolean;
  /** Only reprocess keys recorded as failed by the last run. */
  retryFailed?: boolean;
  /** Apply refuses unless the fresh preview has this digest. */
  confirmPlan?: string;
  /** Polled between batches; returning true stops cleanly (SIGINT). */
  shouldStop?: () => boolean;
}

export interface BackfillReport {
  jobId: string;
  jobVersion: number;
  mode: BackfillMode;
  runId: string | null;
  status: BackfillRunStatus | 'previewed';
  resumedFrom: string | null;
  counters: BackfillCounters;
  diff: BackfillDiffEntry[];
  skipped: BackfillSkippedEntry[];
  failed: BackfillFailedEntry[];
  /** sha256 over the diff; pass to `--confirm-plan` to pin an apply. */
  planDigest: string;
  rollback: string;
  error?: string;
}

export interface BackfillJournalEntry<R> {
  runId: string;
  batch: number;
  key: string;
  before: R;
  after: R;
  at: string;
}

export class BackfillRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackfillRefusedError';
  }
}
