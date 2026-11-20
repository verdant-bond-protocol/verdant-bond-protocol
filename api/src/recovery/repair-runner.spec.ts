import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepairCheckpointStore } from './repair-checkpoint.store';
import { RepairRunner } from './repair-runner';
import { RepairAuthorizationError, RepairJob, RepairRefusedError } from './repair-tool.interface';

const ACTOR = { id: 'operator-1', permissions: ['ops:read', 'ops:repair'] };
const READ_ONLY = { id: 'auditor', permissions: ['ops:read'] };
const NO_PERMS = { id: 'anon', permissions: [] };

describe('Dry-run repair runner with checkpoints', () => {
  let dir: string;
  let runner: RepairRunner;
  let store: RepairCheckpointStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbs-repair-'));
    store = new RepairCheckpointStore(dir);
    runner = new RepairRunner(store);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function makeJob(overrides: Partial<RepairJob> = {}) {
    const inspect = jest.fn(async () => false);
    const apply = jest.fn(async () => undefined);
    const rollback = jest.fn(async () => undefined);
    const job: RepairJob = {
      id: 'test:job',
      description: 'test job',
      steps: [
        { id: 'step-1', description: 'first', inspect, apply, rollback },
        { id: 'step-2', description: 'second', inspect, apply, rollback },
      ],
      ...overrides,
    };
    return { job, inspect, apply, rollback };
  }

  describe('normal paths', () => {
    it('plan is a strict dry run: inspects, never applies, writes nothing', async () => {
      const { job, inspect, apply } = makeJob();
      const report = await runner.plan(job, READ_ONLY);
      expect(report.mode).toBe('dry-run');
      expect(report.planDigest).toMatch(/^[0-9a-f]{16}$/);
      expect(report.steps.map((s) => s.state)).toEqual(['pending', 'pending']);
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(apply).not.toHaveBeenCalled();
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('apply records a checkpoint before and after each step', async () => {
      const { job, apply } = makeJob();
      const report = await runner.apply(job, { actor: ACTOR });
      expect(report.status).toBe('completed');
      expect(report.counters.applied).toBe(2);
      expect(apply).toHaveBeenCalledTimes(2);
      const checkpoint = await store.load(report.runId);
      expect(checkpoint?.state).toBe('applied');
      expect(checkpoint?.steps.every((s) => s.state === 'applied' && s.attempts === 1)).toBe(true);
      expect(checkpoint?.actor).toBe(ACTOR.id);
    });

    it('skips steps that a fresh inspect says are already healthy', async () => {
      const { job, apply, inspect } = makeJob();
      inspect.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      const report = await runner.apply(job, { actor: ACTOR });
      expect(report.counters).toMatchObject({ applied: 0, skipped: 2 });
      expect(apply).not.toHaveBeenCalled();
    });

    it('status and list read checkpoints back', async () => {
      const { job } = makeJob();
      const report = await runner.apply(job, { actor: ACTOR });
      expect((await runner.status(report.runId, READ_ONLY)).state).toBe('applied');
      expect(await runner.list(READ_ONLY)).toHaveLength(1);
    });
  });

  describe('failure paths', () => {
    it('a failed step is checkpointed with its error and stops the run', async () => {
      const { job, apply } = makeJob();
      apply.mockRejectedValueOnce(new Error('write rejected'));
      const report = await runner.apply(job, { actor: ACTOR, maxFailures: 1 });
      expect(report.status).toBe('failed');
      expect(report.counters.failed).toBe(1);
      const checkpoint = await store.load(report.runId);
      expect(checkpoint?.state).toBe('failed');
      expect(checkpoint?.steps[0]).toMatchObject({ state: 'failed', lastError: 'write rejected', attempts: 1 });
      expect(checkpoint?.steps[1].attempts).toBe(0);
    });

    it('an inspect failure fails closed without calling apply', async () => {
      const { job, inspect, apply } = makeJob();
      inspect.mockRejectedValueOnce(new Error('cannot read state'));
      const report = await runner.apply(job, { actor: ACTOR });
      expect(report.counters.failed).toBe(1);
      expect(apply).toHaveBeenCalledTimes(1); // only step-2 was attempted
      expect(report.steps[0].lastError).toContain('cannot read state');
    });

    it('an unknown/corrupt checkpoint is refused', async () => {
      await expect(runner.status('missing', READ_ONLY)).rejects.toBeInstanceOf(RepairRefusedError);
      fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
      await expect(runner.status('broken', READ_ONLY)).rejects.toThrow(/corrupt/);
      await expect(runner.resume('../../etc/passwd', makeJob().job, ACTOR)).rejects.toBeInstanceOf(RepairRefusedError);
    });
  });

  describe('retry paths', () => {
    it('resume retries only the failed step and leaves applied steps alone', async () => {
      const { job, apply, inspect } = makeJob();
      apply.mockRejectedValueOnce(new Error('transient'));
      const first = await runner.apply(job, { actor: ACTOR, maxFailures: 1 });
      expect(first.counters.failed).toBe(1);

      const second = await runner.resume(first.runId, job, ACTOR);
      expect(second.status).toBe('completed');
      expect(apply).toHaveBeenCalledTimes(3); // step-1 twice, step-2 once
      inspect.mockClear();
      apply.mockClear();
      const third = await runner.resume(first.runId, job, ACTOR);
      expect(third.status).toBe('completed');
      // Counts describe the checkpoint's final state; no work was repeated.
      expect(third.counters.applied).toBe(2);
      expect(inspect).toHaveBeenCalledTimes(0); // fully applied steps are not revisited
      expect(apply).not.toHaveBeenCalled();
    });

    it('a completed replay and a stop/resume cycle both converge', async () => {
      const { job, apply } = makeJob();
      let stopped = false;
      apply.mockImplementationOnce(async () => { stopped = true; });
      const first = await runner.apply(job, { actor: ACTOR, shouldStop: () => stopped });
      expect(first.status).toBe('incomplete');
      expect(first.counters.applied).toBe(1);
      const second = await runner.resume(first.runId, job, ACTOR);
      expect(second.status).toBe('completed');
      expect(apply).toHaveBeenCalledTimes(2); // step-1 ran once; step-2 was retried
    });

    it('refuses apply when the confirmed plan digest does not match', async () => {
      const { job, apply } = makeJob();
      await expect(runner.apply(job, { actor: ACTOR, confirmPlan: 'deadbeef' }))
        .rejects.toThrow(/digest mismatch/);
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(apply).not.toHaveBeenCalled();
    });

    it('refuses to resume a job whose steps changed since the checkpoint', async () => {
      const { job } = makeJob();
      const first = await runner.apply(job, { actor: ACTOR, confirmPlan: runner.digest(job) });
      const changed: RepairJob = { ...job, steps: [...job.steps, {
        id: 'step-3', description: 'new', inspect: () => true, apply: () => undefined,
      }] };
      await expect(runner.resume(first.runId, changed, ACTOR)).rejects.toThrow(/job changed/);
    });
  });

  describe('authorization paths', () => {
    it('plan needs read access and writes need repair access', async () => {
      const { job, inspect, apply } = makeJob();
      await expect(runner.plan(job, NO_PERMS)).rejects.toBeInstanceOf(RepairAuthorizationError);
      await expect(runner.apply(job, { actor: NO_PERMS })).rejects.toBeInstanceOf(RepairAuthorizationError);
      await expect(runner.apply(job, { actor: READ_ONLY })).rejects.toBeInstanceOf(RepairAuthorizationError);
      expect(inspect).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('resume and rollback also enforce repair access', async () => {
      const { job } = makeJob();
      const report = await runner.apply(job, { actor: ACTOR });
      await expect(runner.resume(report.runId, job, READ_ONLY)).rejects.toBeInstanceOf(RepairAuthorizationError);
      await expect(runner.rollback(report.runId, job, READ_ONLY)).rejects.toBeInstanceOf(RepairAuthorizationError);
    });
  });

  describe('rollback', () => {
    it('rolls applied steps back in reverse order', async () => {
      const order: string[] = [];
      const job: RepairJob = {
        id: 'rollback:job', description: 'rollback job',
        steps: [
          {
            id: 'a', description: 'a', inspect: () => false, apply: () => undefined,
            rollback: () => { order.push('a'); },
          },
          {
            id: 'b', description: 'b', inspect: () => false, apply: () => undefined,
            rollback: () => { order.push('b'); },
          },
        ],
      };
      const report = await runner.apply(job, { actor: ACTOR });
      const result = await runner.rollback(report.runId, job, ACTOR);
      expect(order).toEqual(['b', 'a']);
      expect(result.conflicts).toEqual([]);
      expect((await store.load(report.runId))?.state).toBe('rolled-back');
      expect(result.report.counters.rolledBack).toBe(2);
    });

    it('records conflicts for a missing or failing rollback action', async () => {
      const job: RepairJob = {
        id: 'rollback:partial', description: 'partial rollback',
        steps: [{
          id: 'no-undo', description: 'no undo', inspect: () => false, apply: () => undefined,
        }],
      };
      const report = await runner.apply(job, { actor: ACTOR });
      const result = await runner.rollback(report.runId, job, ACTOR);
      expect(result.conflicts).toContain('no-undo: no rollback action');
      expect((await store.load(report.runId))?.state).toBe('failed');

      const job2: RepairJob = {
        id: 'rollback:throwing', description: 'throwing rollback',
        steps: [{
          id: 'throws', description: 'throws', inspect: () => false, apply: () => undefined,
          rollback: () => { throw new Error('backup missing'); },
        }],
      };
      const report2 = await runner.apply(job2, { actor: ACTOR });
      const result2 = await runner.rollback(report2.runId, job2, ACTOR);
      expect(result2.conflicts).toContain('throws: backup missing');
    });
  });
});
