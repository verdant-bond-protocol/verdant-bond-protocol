import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BackfillChange,
  BackfillDecision,
  BackfillJob,
  BackfillRefusedError,
  BackfillRestoreResult,
} from './backfill.interface';
import { BackfillRunner } from './backfill-runner';
import { BackfillStateStore } from './backfill-state.store';

interface Rec {
  value?: number;
  bad?: boolean;
  skip?: boolean;
}

class FakeJob implements BackfillJob<Rec> {
  readonly id = 'fake';
  readonly description = 'set missing value to 0';
  readonly rollback = 'rollback --run <id>';
  commits = 0;
  /** Commit numbers (1-based) that throw. */
  failCommits = new Set<number>();
  failAlways = false;

  constructor(readonly data: Map<string, Rec>, public version = 1) {}

  async open(): Promise<void> {}
  async listKeys(): Promise<string[]> {
    return [...this.data.keys()];
  }
  async load(key: string): Promise<Rec | null> {
    const r = this.data.get(key);
    return r ? { ...r } : null;
  }
  plan(_key: string, record: Rec): BackfillDecision<Rec> {
    if (record.bad) throw new Error('bad record');
    if (record.skip) return { action: 'skip', reason: 'flagged' };
    if (record.value === undefined) return { action: 'update', after: { ...record, value: 0 }, changes: ['value: <missing> → 0'] };
    return { action: 'noop' };
  }
  async commit(changes: BackfillChange<Rec>[]): Promise<void> {
    this.commits++;
    if (this.failAlways || this.failCommits.has(this.commits)) throw new Error('disk full');
    for (const c of changes) this.data.set(c.key, c.after);
  }
  async restore(changes: BackfillChange<Rec>[]): Promise<BackfillRestoreResult> {
    const result: BackfillRestoreResult = { restored: [], conflicts: [] };
    for (const c of changes) {
      if (JSON.stringify(this.data.get(c.key)) === JSON.stringify(c.after)) {
        this.data.set(c.key, c.before);
        result.restored.push(c.key);
      } else {
        result.conflicts.push({ key: c.key, reason: 'modified' });
      }
    }
    return result;
  }
}

function seed(n: number, extra: Record<string, Rec> = {}): Map<string, Rec> {
  const data = new Map<string, Rec>();
  for (let i = 0; i < n; i++) data.set(`k${String(i).padStart(2, '0')}`, i % 2 === 0 ? {} : { value: i });
  for (const [k, v] of Object.entries(extra)) data.set(k, v);
  return data;
}

describe('BackfillRunner', () => {
  let dir: string;
  let store: BackfillStateStore;
  let runner: BackfillRunner;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
    store = new BackfillStateStore(dir);
    runner = new BackfillRunner(store);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('dry-run reports the diff, skips and failures without writing anything', async () => {
    const job = new FakeJob(seed(4, { zz: { bad: true }, yy: { skip: true } }));
    const before = JSON.stringify([...job.data]);

    const report = await runner.preview(job);

    expect(report.mode).toBe('dry-run');
    expect(report.counters).toEqual({ scanned: 6, updated: 2, unchanged: 2, skipped: 1, failed: 1 });
    expect(report.diff.map((d) => d.key)).toEqual(['k00', 'k02']);
    expect(report.skipped).toEqual([{ key: 'yy', reason: 'flagged' }]);
    expect(report.failed).toEqual([{ key: 'zz', error: 'bad record', attempts: 1 }]);
    expect(JSON.stringify([...job.data])).toBe(before);
    expect(job.commits).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect((await runner.preview(job)).planDigest).toBe(report.planDigest);
  });

  it('applies in batches, checkpoints, journals and releases the lock', async () => {
    const job = new FakeJob(seed(10));
    const report = await runner.apply(job, { batchSize: 3 });

    expect(report.status).toBe('completed');
    expect(report.counters).toEqual({ scanned: 10, updated: 5, unchanged: 5, skipped: 0, failed: 0 });
    expect([...job.data.values()].every((r) => r.value !== undefined)).toBe(true);
    // Four batches, but the last (k09 only) has nothing to update, so no commit.
    expect(job.commits).toBe(3);
    const cp = store.readCheckpoint('fake')!;
    expect(cp.status).toBe('completed');
    expect(cp.cursor).toBe('k09');
    expect(store.readJournal('fake', report.runId!)).toHaveLength(5);
    expect(fs.existsSync(store.lockPath('fake'))).toBe(false);
  });

  it('stops on signal, refuses an implicit restart, and resumes to the same end state', async () => {
    const job = new FakeJob(seed(10));
    let batches = 0;
    const first = await runner.apply(job, { batchSize: 4, shouldStop: () => batches++ >= 1 });
    expect(first.status).toBe('interrupted');
    expect(store.readCheckpoint('fake')!.cursor).toBe('k03');

    await expect(runner.apply(job)).rejects.toThrow(/--resume/);

    const second = await runner.apply(job, { batchSize: 4, resume: true });
    expect(second.status).toBe('completed');
    expect(second.runId).toBe(first.runId);
    expect(second.resumedFrom).toBe('k03');
    expect(second.counters).toEqual({ scanned: 10, updated: 5, unchanged: 5, skipped: 0, failed: 0 });

    const reference = new FakeJob(seed(10));
    await new BackfillRunner(new BackfillStateStore(path.join(dir, 'ref'))).apply(reference);
    expect([...job.data]).toEqual([...reference.data]);
  });

  it('aborts on a persistent commit failure without advancing the cursor, then resumes', async () => {
    const job = new FakeJob(seed(6));
    job.failCommits = new Set([2, 3, 4]);
    const report = await runner.apply(job, { batchSize: 2, maxCommitAttempts: 3 });

    expect(report.status).toBe('aborted');
    expect(report.error).toMatch(/batch 2 commit failed after 3 attempt\(s\): disk full/);
    const cp = store.readCheckpoint('fake')!;
    expect(cp.cursor).toBe('k01');
    expect(cp.failed.map((f) => f.key)).toEqual(['k02']);
    expect(cp.counters.scanned).toBe(2);

    const resumed = await runner.apply(job, { batchSize: 2, resume: true });
    expect(resumed.status).toBe('completed');
    expect(resumed.failed).toEqual([]);
    expect(resumed.counters).toEqual({ scanned: 6, updated: 3, unchanged: 3, skipped: 0, failed: 0 });
  });

  it('retries a transient commit failure within the same run', async () => {
    const job = new FakeJob(seed(4));
    job.failCommits = new Set([1]);
    const report = await runner.apply(job, { batchSize: 10 });
    expect(report.status).toBe('completed');
    expect(job.commits).toBe(2);
  });

  it('aborts once the failure threshold is reached', async () => {
    const extra: Record<string, Rec> = {};
    for (let i = 0; i < 5; i++) extra[`b${i}`] = { bad: true };
    const job = new FakeJob(seed(4, extra));
    const report = await runner.apply(job, { batchSize: 1, maxFailures: 3 });
    expect(report.status).toBe('aborted');
    expect(report.failed).toHaveLength(3);
    expect(report.error).toMatch(/failure threshold/);
  });

  it('honours --limit as a canary and resumes past it', async () => {
    const job = new FakeJob(seed(10));
    const canary = await runner.apply(job, { batchSize: 4, limit: 3 });
    expect(canary.status).toBe('interrupted');
    expect(canary.counters.scanned).toBe(3);
    const rest = await runner.apply(job, { resume: true });
    expect(rest.status).toBe('completed');
    expect(rest.counters.scanned).toBe(10);
  });

  it('pins an apply to a reviewed plan digest', async () => {
    const job = new FakeJob(seed(4));
    const { planDigest } = await runner.preview(job);
    job.data.set('k05', {});
    await expect(runner.apply(job, { confirmPlan: planDigest })).rejects.toThrow(/Plan changed/);
    expect(job.commits).toBe(0);

    const fresh = await runner.preview(job);
    expect((await runner.apply(job, { confirmPlan: fresh.planDigest })).status).toBe('completed');
  });

  it('refuses to resume a checkpoint written by another job version', async () => {
    const job = new FakeJob(seed(6));
    await runner.apply(job, { batchSize: 2, limit: 2 });
    job.version = 2;
    await expect(runner.apply(job, { resume: true })).rejects.toThrow(/fake@1/);
    expect((await runner.apply(job, { restart: true })).status).toBe('completed');
  });

  it('refuses a concurrent run and allows a forced unlock', async () => {
    const job = new FakeJob(seed(2));
    fs.writeFileSync(store.lockPath('fake'), JSON.stringify({ pid: 999999, host: os.hostname(), startedAt: 'x' }));
    await expect(runner.apply(job)).rejects.toThrow(BackfillRefusedError);
    await expect(runner.apply(job)).rejects.toThrow(/stale/);
    expect((await runner.apply(job, { forceUnlock: true })).status).toBe('completed');
    expect(fs.existsSync(store.lockPath('fake'))).toBe(false);
  });

  it('reprocesses only failed records with --retry-failed', async () => {
    const job = new FakeJob(seed(4, { zz: { bad: true } }));
    const first = await runner.apply(job);
    expect(first.status).toBe('completed');
    expect(first.failed.map((f) => f.key)).toEqual(['zz']);

    job.data.set('zz', {});
    const retry = await runner.apply(job, { retryFailed: true });
    expect(retry.counters).toEqual({ scanned: 1, updated: 1, unchanged: 0, skipped: 0, failed: 0 });
    expect(store.readCheckpoint('fake')!.retryOf).toBe(first.runId);
    await expect(runner.apply(job, { retryFailed: true })).rejects.toThrow(/nothing to retry/);
  });

  it('rolls back a run and reports records edited since as conflicts', async () => {
    const job = new FakeJob(seed(6));
    const original = new Map(job.data);
    const report = await runner.apply(job, { batchSize: 2 });
    job.data.set('k02', { value: 42 });

    const result = await runner.rollback(job, report.runId!);

    expect(result.restored.sort()).toEqual(['k00', 'k04']);
    expect(result.conflicts).toEqual([{ key: 'k02', reason: 'modified' }]);
    expect(job.data.get('k00')).toEqual(original.get('k00'));
    expect(job.data.get('k02')).toEqual({ value: 42 });
    expect(store.readCheckpoint('fake')!.status).toBe('rolled-back');
    expect((await runner.apply(job)).status).toBe('completed');
  });

  it('ignores a torn final journal line from a crash mid-append', async () => {
    const job = new FakeJob(seed(4));
    const report = await runner.apply(job);
    fs.appendFileSync(store.journalPath('fake', report.runId!), '{"runId":"x","ke');
    expect(store.readJournal('fake', report.runId!)).toHaveLength(2);
  });
});
