import { OperationCancellationService } from '../../common/services/operation-cancellation.service';
import { CancellableJobRunner, JobCancellationForbiddenError, JobStep } from './cancellable-job.runner';

describe('CancellableJobRunner (#536)', () => {
  let cancellation: OperationCancellationService;
  let runner: CancellableJobRunner;
  let log: string[];

  const step = (name: string, run?: JobStep['run']): JobStep => ({
    name,
    run: run ?? (() => { log.push(`run:${name}`); }),
    cleanup: () => { log.push(`cleanup:${name}`); },
  });

  beforeEach(() => {
    cancellation = new OperationCancellationService();
    runner = new CancellableJobRunner(cancellation);
    log = [];
  });

  it('completes all steps without cleanup', async () => {
    const result = await runner.run({ jobId: 'j1', ownerId: 'u1', steps: [step('a'), step('b')] });
    expect(result.outcome).toBe('completed');
    expect(result.completedSteps).toEqual(['a', 'b']);
    expect(log).toEqual(['run:a', 'run:b']);
    expect(cancellation.listActive()).toEqual([]);
  });

  it('stops between steps on cancel and cleans up in reverse order', async () => {
    const result = await runner.run({
      jobId: 'j2',
      ownerId: 'u1',
      steps: [
        step('a'),
        step('b', () => { log.push('run:b'); runner.cancel('j2', { id: 'u1' }); }),
        step('c'),
      ],
    });
    expect(result.outcome).toBe('cancelled');
    expect(log).toEqual(['run:a', 'run:b', 'cleanup:b', 'cleanup:a']);
    expect(result.completedSteps).toEqual([]);
    expect(cancellation.listActive()).toEqual([]);
  });

  it('runs remaining cleanups when one cleanup fails', async () => {
    const steps: JobStep[] = [
      step('a'),
      { name: 'b', run: () => undefined, cleanup: () => { throw new Error('boom'); } },
      step('c', () => { throw new Error('step failed'); }),
    ];
    const result = await runner.run({ jobId: 'j3', ownerId: 'u1', steps });
    expect(result.outcome).toBe('failed');
    expect(result.error).toBe('step failed');
    expect(result.cleanupErrors).toEqual([{ step: 'b', message: 'boom' }]);
    expect(result.cleanedUpSteps).toEqual(['a']);
    expect(result.completedSteps).toEqual(['b']);
  });

  it('keeps a checkpoint on failure when cleanupOnFailure is false and resumes from it', async () => {
    let attempts = 0;
    const flaky = step('b', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      log.push('run:b');
    });
    const first = await runner.run({ jobId: 'j4', ownerId: 'u1', steps: [step('a'), flaky], cleanupOnFailure: false });
    expect(first.outcome).toBe('failed');
    expect(first.completedSteps).toEqual(['a']);

    log = [];
    const retry = await runner.run({ jobId: 'j4', ownerId: 'u1', steps: [step('a'), flaky], resumeFrom: first.completedSteps });
    expect(retry.outcome).toBe('completed');
    expect(log).toEqual(['run:b']);
    expect(retry.completedSteps).toEqual(['a', 'b']);
  });

  it('times out and cleans up', async () => {
    const result = await runner.run({
      jobId: 'j5',
      ownerId: 'u1',
      timeoutMs: 5,
      steps: [step('a'), step('slow', () => new Promise((resolve) => setTimeout(resolve, 30))), step('c')],
    });
    expect(result.outcome).toBe('timed_out');
    expect(log).toContain('cleanup:a');
    expect(log).not.toContain('run:c');
  });

  it('enforces cancel authorization and is idempotent', async () => {
    let gate: () => void = () => undefined;
    const running = runner.run({
      jobId: 'j6',
      ownerId: 'owner',
      steps: [step('wait', () => new Promise<void>((resolve) => { gate = resolve; })), step('after')],
    });
    expect(() => runner.cancel('j6', { id: 'intruder' })).toThrow(JobCancellationForbiddenError);
    expect(runner.cancel('j6', { id: 'admin', isAdmin: true })).toBe(true);
    expect(runner.cancel('j6', { id: 'owner' })).toBe(false);
    gate();
    expect((await running).outcome).toBe('cancelled');
    expect(runner.cancel('j6', { id: 'owner' })).toBe(false);
  });

  it('rejects duplicate step names', async () => {
    await expect(runner.run({ jobId: 'j7', ownerId: 'u', steps: [step('a'), step('a')] })).rejects.toThrow();
  });
});
