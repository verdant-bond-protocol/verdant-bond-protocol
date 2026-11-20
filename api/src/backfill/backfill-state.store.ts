import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BackfillCheckpoint,
  BackfillJournalEntry,
  BackfillRefusedError,
} from './backfill.interface';

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

/**
 * Durable state for backfill runs: one checkpoint, one lock and one
 * write-ahead journal per run, all under a single directory.
 *
 * Checkpoints are written to a temp file, fsynced and renamed, so a crash
 * mid-write leaves the previous checkpoint intact rather than a torn file.
 */
export class BackfillStateStore {
  constructor(readonly dir: string) {}

  static defaultDir(): string {
    return process.env.BACKFILL_STATE_DIR || path.join(process.cwd(), 'data', 'backfill');
  }

  checkpointPath(jobId: string): string {
    return path.join(this.dir, `${jobId}.checkpoint.json`);
  }

  lockPath(jobId: string): string {
    return path.join(this.dir, `${jobId}.lock`);
  }

  journalPath(jobId: string, runId: string): string {
    return path.join(this.dir, `${jobId}.${runId}.journal.jsonl`);
  }

  readCheckpoint(jobId: string): BackfillCheckpoint | null {
    const file = this.checkpointPath(jobId);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    try {
      return JSON.parse(raw) as BackfillCheckpoint;
    } catch {
      throw new BackfillRefusedError(
        `Checkpoint ${file} is not valid JSON. Inspect it by hand; ` +
          'remove it only once you know which keys were committed (see the journal).',
      );
    }
  }

  writeCheckpoint(checkpoint: BackfillCheckpoint): void {
    this.ensureDir();
    const file = this.checkpointPath(checkpoint.jobId);
    const tmp = `${file}.tmp.${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(checkpoint, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  /** Append journal lines and fsync before the caller commits the batch. */
  appendJournal<R>(jobId: string, entries: BackfillJournalEntry<R>[]): void {
    if (entries.length === 0) return;
    this.ensureDir();
    const fd = fs.openSync(this.journalPath(jobId, entries[0].runId), 'a');
    try {
      fs.writeSync(fd, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Read a run's journal. A torn final line (crash mid-append) is ignored:
   * its batch was never committed, because commit happens after the fsync.
   */
  readJournal<R>(jobId: string, runId: string): BackfillJournalEntry<R>[] {
    const file = this.journalPath(jobId, runId);
    if (!fs.existsSync(file)) {
      throw new BackfillRefusedError(`No journal for run ${runId} at ${file}.`);
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const entries: BackfillJournalEntry<R>[] = [];
    lines.forEach((line, i) => {
      try {
        entries.push(JSON.parse(line));
      } catch (error) {
        if (i !== lines.length - 1) throw error;
      }
    });
    return entries;
  }

  acquireLock(jobId: string, forceUnlock = false): () => void {
    this.ensureDir();
    const file = this.lockPath(jobId);
    const info: LockInfo = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
    try {
      fs.writeFileSync(file, JSON.stringify(info), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = this.readLock(file);
      if (!forceUnlock) {
        const stale = holder && this.isStale(holder) ? ' It looks stale (process is gone);' : '';
        throw new BackfillRefusedError(
          `Job ${jobId} is locked by ${holder ? `pid ${holder.pid} on ${holder.host} since ${holder.startedAt}` : 'an unreadable lock file'}.` +
            `${stale} confirm no run is active, then pass --force-unlock.`,
        );
      }
      fs.writeFileSync(file, JSON.stringify(info));
    }
    return () => {
      const holder = this.readLock(file);
      if (holder && holder.pid === process.pid && holder.host === info.host) {
        fs.rmSync(file, { force: true });
      }
    };
  }

  private readLock(file: string): LockInfo | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo;
    } catch {
      return null;
    }
  }

  private isStale(lock: LockInfo): boolean {
    if (lock.host !== os.hostname()) return false;
    try {
      process.kill(lock.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }
}
