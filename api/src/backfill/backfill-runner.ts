import * as crypto from 'crypto';
import {
  BackfillChange,
  BackfillCheckpoint,
  BackfillCounters,
  BackfillDiffEntry,
  BackfillFailedEntry,
  BackfillJob,
  BackfillJournalEntry,
  BackfillOptions,
  BackfillRefusedError,
  BackfillReport,
  BackfillRestoreResult,
  BackfillSkippedEntry,
} from './backfill.interface';
import { BackfillStateStore } from './backfill-state.store';

export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_MAX_FAILURES = 25;
export const DEFAULT_MAX_COMMIT_ATTEMPTS = 3;

const FINISHED = new Set(['completed', 'rolled-back']);

interface KeySelection {
  keys: string[];
  /** Checkpoint being continued, when resuming. */
  resumeFrom: BackfillCheckpoint | null;
  retryOf: BackfillCheckpoint | null;
}

interface BatchOutcome<R> {
  counters: BackfillCounters;
  changes: BackfillChange<R>[];
  diff: BackfillDiffEntry[];
  skipped: BackfillSkippedEntry[];
  failed: BackfillFailedEntry[];
}

export function emptyCounters(): BackfillCounters {
  return { scanned: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
}

export function fingerprint(job: BackfillJob<unknown>): string {
  return crypto.createHash('sha256').update(`${job.id}@${job.version}`).digest('hex').slice(0, 16);
}

export function planDigest(diff: BackfillDiffEntry[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(diff)).digest('hex');
}

export class BackfillRunner {
  constructor(private readonly store: BackfillStateStore) {}

  /** Preview what `apply` with the same options would do. Writes nothing. */
  async preview<R>(job: BackfillJob<R>, options: Omit<BackfillOptions, 'mode'> = {}): Promise<BackfillReport> {
    await job.open();
    const existing = this.store.readCheckpoint(job.id);
    const selection = await this.selectKeys(job, existing, options);
    const limit = options.limit ?? Infinity;
    const outcome = await this.planBatch(job, selection.keys.slice(0, limit));
    return {
      jobId: job.id,
      jobVersion: job.version,
      mode: 'dry-run',
      runId: null,
      status: 'previewed',
      resumedFrom: selection.resumeFrom?.cursor ?? null,
      counters: outcome.counters,
      diff: outcome.diff,
      skipped: outcome.skipped,
      failed: outcome.failed,
      planDigest: planDigest(outcome.diff),
      rollback: job.rollback,
    };
  }

  async apply<R>(
    job: BackfillJob<R>,
    options: Omit<BackfillOptions, 'mode'> & { forceUnlock?: boolean } = {},
  ): Promise<BackfillReport> {
    const release = this.store.acquireLock(job.id, options.forceUnlock);
    try {
      return await this.applyLocked(job, options);
    } finally {
      release();
    }
  }

  async rollback<R>(
    job: BackfillJob<R>,
    runId: string,
    options: { batchSize?: number; forceUnlock?: boolean } = {},
  ): Promise<BackfillRestoreResult> {
    const release = this.store.acquireLock(job.id, options.forceUnlock);
    try {
      await job.open();
      const entries = this.store.readJournal<R>(job.id, runId);
      // Undo newest-first so a key journalled twice ends at its oldest before-image.
      const changes = entries
        .reverse()
        .map((e): BackfillChange<R> => ({ key: e.key, before: e.before, after: e.after }));
      const size = options.batchSize ?? DEFAULT_BATCH_SIZE;
      const result: BackfillRestoreResult = { restored: [], conflicts: [] };
      for (let i = 0; i < changes.length; i += size) {
        const part = await job.restore(changes.slice(i, i + size));
        result.restored.push(...part.restored);
        result.conflicts.push(...part.conflicts);
      }
      const checkpoint = this.store.readCheckpoint(job.id);
      if (checkpoint && checkpoint.runId === runId) {
        this.store.writeCheckpoint({
          ...checkpoint,
          status: 'rolled-back',
          updatedAt: new Date().toISOString(),
          error: result.conflicts.length
            ? `rolled back with ${result.conflicts.length} conflict(s)`
            : checkpoint.error,
        });
      }
      return result;
    } finally {
      release();
    }
  }

  status(jobId: string): BackfillCheckpoint | null {
    return this.store.readCheckpoint(jobId);
  }

  private async applyLocked<R>(
    job: BackfillJob<R>,
    options: Omit<BackfillOptions, 'mode'>,
  ): Promise<BackfillReport> {
    await job.open();
    const existing = this.store.readCheckpoint(job.id);
    const selection = await this.selectKeys(job, existing, options);
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    const limit = options.limit ?? Infinity;
    const maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    const maxAttempts = Math.max(1, options.maxCommitAttempts ?? DEFAULT_MAX_COMMIT_ATTEMPTS);

    if (options.confirmPlan) {
      if (selection.resumeFrom) {
        throw new BackfillRefusedError('--confirm-plan only applies to a fresh run, not a resume.');
      }
      const preview = await this.planBatch(job, selection.keys.slice(0, limit));
      const digest = planDigest(preview.diff);
      if (digest !== options.confirmPlan) {
        throw new BackfillRefusedError(
          `Plan changed since it was reviewed (expected ${options.confirmPlan}, now ${digest}). Re-run the dry-run and review again.`,
        );
      }
    }

    const now = new Date().toISOString();
    const checkpoint: BackfillCheckpoint = selection.resumeFrom
      ? { ...selection.resumeFrom, status: 'running', error: undefined, updatedAt: now }
      : {
          jobId: job.id,
          jobVersion: job.version,
          fingerprint: fingerprint(job),
          runId: `${now.replace(/[-:.]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`,
          status: 'running',
          cursor: null,
          counters: emptyCounters(),
          skipped: [],
          failed: [],
          retryOf: selection.retryOf?.runId,
          keySet: selection.retryOf ? selection.keys : undefined,
          startedAt: now,
          updatedAt: now,
        };
    this.store.writeCheckpoint(checkpoint);

    const diff: BackfillDiffEntry[] = [];
    let processed = 0;
    let batchNo = 0;
    let stopReason: { status: 'interrupted' | 'aborted'; error: string } | null = null;

    for (let i = 0; i < selection.keys.length && processed < limit; i += batchSize) {
      if (options.shouldStop?.()) {
        stopReason = { status: 'interrupted', error: 'stopped by operator signal' };
        break;
      }
      const keys = selection.keys.slice(i, Math.min(i + batchSize, i + (limit - processed)));
      const outcome = await this.planBatch(job, keys);
      batchNo++;

      if (outcome.changes.length > 0) {
        const at = new Date().toISOString();
        this.store.appendJournal<R>(
          job.id,
          outcome.changes.map(
            (c): BackfillJournalEntry<R> => ({ runId: checkpoint.runId, batch: batchNo, key: c.key, before: c.before, after: c.after, at }),
          ),
        );
        const commitError = await this.commitWithRetry(job, outcome.changes, maxAttempts);
        if (commitError) {
          // Cursor stays put: the whole batch is retried on resume.
          mergeFailed(
            checkpoint.failed,
            outcome.changes.map((c) => ({ key: c.key, error: `commit failed: ${commitError}`, attempts: maxAttempts })),
          );
          stopReason = { status: 'aborted', error: `batch ${batchNo} commit failed after ${maxAttempts} attempt(s): ${commitError}` };
          break;
        }
      }

      addCounters(checkpoint.counters, outcome.counters);
      mergeSkipped(checkpoint.skipped, outcome.skipped);
      mergeFailed(checkpoint.failed, outcome.failed);
      // Keys that now succeeded drop out of the failed list (e.g. after a commit retry).
      const failedNow = new Set(outcome.failed.map((f) => f.key));
      checkpoint.failed = checkpoint.failed.filter((f) => !keys.includes(f.key) || failedNow.has(f.key));
      checkpoint.cursor = keys[keys.length - 1];
      checkpoint.updatedAt = new Date().toISOString();
      this.store.writeCheckpoint(checkpoint);
      diff.push(...outcome.diff);
      processed += keys.length;

      if (checkpoint.failed.length >= maxFailures) {
        stopReason = { status: 'aborted', error: `failure threshold reached (${checkpoint.failed.length} >= ${maxFailures})` };
        break;
      }
    }

    if (!stopReason && processed < selection.keys.length) {
      stopReason = { status: 'interrupted', error: `limit of ${limit} record(s) reached; resume to continue` };
    }
    checkpoint.status = stopReason?.status ?? 'completed';
    checkpoint.error = stopReason?.error;
    checkpoint.updatedAt = new Date().toISOString();
    this.store.writeCheckpoint(checkpoint);

    return {
      jobId: job.id,
      jobVersion: job.version,
      mode: 'apply',
      runId: checkpoint.runId,
      status: checkpoint.status,
      resumedFrom: selection.resumeFrom?.cursor ?? null,
      counters: { ...checkpoint.counters },
      diff,
      skipped: [...checkpoint.skipped],
      failed: [...checkpoint.failed],
      planDigest: planDigest(diff),
      rollback: job.rollback,
      error: checkpoint.error,
    };
  }

  /**
   * Decide which keys a run covers, refusing ambiguous operator intent:
   * an unfinished run must be explicitly resumed or restarted.
   */
  private async selectKeys<R>(
    job: BackfillJob<R>,
    existing: BackfillCheckpoint | null,
    options: Omit<BackfillOptions, 'mode'>,
  ): Promise<KeySelection> {
    const unfinished = existing && !FINISHED.has(existing.status) ? existing : null;

    if (options.resume && options.restart) {
      throw new BackfillRefusedError('Pass either --resume or --restart, not both.');
    }

    if (options.retryFailed) {
      if (unfinished) {
        throw new BackfillRefusedError(
          `Run ${unfinished.runId} is ${unfinished.status}; resume or restart it before retrying failures.`,
        );
      }
      if (!existing || existing.failed.length === 0) {
        throw new BackfillRefusedError(`No failed records recorded for ${job.id}; nothing to retry.`);
      }
      return { keys: existing.failed.map((f) => f.key).sort(), resumeFrom: null, retryOf: existing };
    }

    if (unfinished && !options.restart) {
      if (!options.resume) {
        throw new BackfillRefusedError(
          `Run ${unfinished.runId} is ${unfinished.status} at cursor ${JSON.stringify(unfinished.cursor)}` +
            `${unfinished.error ? ` (${unfinished.error})` : ''}. Pass --resume to continue it or --restart to start over.`,
        );
      }
      if (unfinished.jobVersion !== job.version || unfinished.fingerprint !== fingerprint(job)) {
        throw new BackfillRefusedError(
          `Checkpoint was written by ${unfinished.jobId}@${unfinished.jobVersion}, this is ${job.id}@${job.version}. ` +
            'Its cursor cannot be trusted; roll back or --restart.',
        );
      }
      const source = unfinished.keySet ?? (await job.listKeys());
      const cursor = unfinished.cursor;
      const keys = [...source].sort().filter((k) => cursor === null || k > cursor);
      return { keys, resumeFrom: unfinished, retryOf: null };
    }

    if (options.resume) {
      throw new BackfillRefusedError(`No unfinished run of ${job.id} to resume.`);
    }
    return { keys: [...(await job.listKeys())].sort(), resumeFrom: null, retryOf: null };
  }

  private async planBatch<R>(job: BackfillJob<R>, keys: string[]): Promise<BatchOutcome<R>> {
    const outcome: BatchOutcome<R> = { counters: emptyCounters(), changes: [], diff: [], skipped: [], failed: [] };
    for (const key of keys) {
      outcome.counters.scanned++;
      let record: R | null;
      try {
        record = await job.load(key);
      } catch (error) {
        outcome.counters.failed++;
        outcome.failed.push({ key, error: `load failed: ${message(error)}`, attempts: 1 });
        continue;
      }
      if (record === null) {
        outcome.counters.skipped++;
        outcome.skipped.push({ key, reason: 'record no longer exists' });
        continue;
      }
      try {
        const decision = job.plan(key, record);
        if (decision.action === 'update') {
          outcome.counters.updated++;
          outcome.changes.push({ key, before: record, after: decision.after });
          outcome.diff.push({ key, changes: decision.changes });
        } else if (decision.action === 'skip') {
          outcome.counters.skipped++;
          outcome.skipped.push({ key, reason: decision.reason });
        } else {
          outcome.counters.unchanged++;
        }
      } catch (error) {
        outcome.counters.failed++;
        outcome.failed.push({ key, error: message(error), attempts: 1 });
      }
    }
    return outcome;
  }

  private async commitWithRetry<R>(
    job: BackfillJob<R>,
    changes: BackfillChange<R>[],
    maxAttempts: number,
  ): Promise<string | null> {
    let last = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await job.commit(changes);
        return null;
      } catch (error) {
        last = message(error);
      }
    }
    return last;
  }
}

function addCounters(into: BackfillCounters, add: BackfillCounters): void {
  into.scanned += add.scanned;
  into.updated += add.updated;
  into.unchanged += add.unchanged;
  into.skipped += add.skipped;
  into.failed += add.failed;
}

function mergeSkipped(into: BackfillSkippedEntry[], add: BackfillSkippedEntry[]): void {
  for (const entry of add) {
    const i = into.findIndex((e) => e.key === entry.key);
    if (i >= 0) into[i] = entry;
    else into.push(entry);
  }
}

function mergeFailed(into: BackfillFailedEntry[], add: BackfillFailedEntry[]): void {
  for (const entry of add) {
    const i = into.findIndex((e) => e.key === entry.key);
    if (i >= 0) into[i] = { ...entry, attempts: into[i].attempts + entry.attempts };
    else into.push(entry);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
