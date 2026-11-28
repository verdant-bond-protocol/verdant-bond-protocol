import { JobType } from '../interfaces/job.interface';
import {
  DEFAULT_WORKER_CONCURRENCY,
  MAX_WORKER_CONCURRENCY,
  resolveWorkerConcurrency,
} from './worker-concurrency';
import { WorkerService } from './worker.service';

describe('resolveWorkerConcurrency (#557)', () => {
  it('defaults to one job at a time', () => {
    expect(resolveWorkerConcurrency({})).toBe(DEFAULT_WORKER_CONCURRENCY);
    expect(DEFAULT_WORKER_CONCURRENCY).toBe(1);
  });

  it('accepts a positive integer', () => {
    expect(resolveWorkerConcurrency({ WORKER_CONCURRENCY: '4' })).toBe(4);
  });

  it('keeps the default for malformed or non-positive values', () => {
    for (const raw of ['', 'abc', '0', '-3', '1.5', 'NaN', 'Infinity']) {
      expect(resolveWorkerConcurrency({ WORKER_CONCURRENCY: raw })).toBe(DEFAULT_WORKER_CONCURRENCY);
    }
  });

  it('clamps to the hard ceiling so a typo cannot unbound the worker', () => {
    expect(resolveWorkerConcurrency({ WORKER_CONCURRENCY: '10000' })).toBe(MAX_WORKER_CONCURRENCY);
  });
});

describe('WorkerService bounded concurrency (#557)', () => {
  let queue: { dequeue: jest.Mock; markSuccess: jest.Mock; markFailure: jest.Mock };
  let telemetry: { emit: jest.Mock };
  let handler: { handle: jest.Mock };
  let dequeued: number;
  const original = process.env.WORKER_CONCURRENCY;

  const job = (id: string) => ({
    id,
    type: JobType.DATA_EXPORT,
    correlationId: `corr-${id}`,
    payload: { data: { id }, userId: 'user-1' },
  });

  const deferred = () => {
    let resolve!: (value: Record<string, any>) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<Record<string, any>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  /** Let queued microtasks and handler calls run (setImmediate is not faked). */
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  const build = (concurrency?: number): WorkerService => {
    if (concurrency === undefined) delete process.env.WORKER_CONCURRENCY;
    else process.env.WORKER_CONCURRENCY = String(concurrency);
    const worker = new WorkerService(queue as any, telemetry as any);
    worker.registerHandler(JobType.DATA_EXPORT, handler);
    return worker;
  };

  beforeEach(() => {
    // WorkerService arms a 5-minute timeout per job; never let it fire.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    dequeued = 0;
    queue = {
      dequeue: jest.fn(async () => job(`j${++dequeued}`)),
      markSuccess: jest.fn().mockResolvedValue(undefined),
      markFailure: jest.fn().mockResolvedValue(true),
    };
    telemetry = { emit: jest.fn() };
    handler = { handle: jest.fn() };
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    if (original === undefined) delete process.env.WORKER_CONCURRENCY;
    else process.env.WORKER_CONCURRENCY = original;
  });

  it('processes one job at a time by default and refuses to claim a second', async () => {
    const worker = build();
    const gate = deferred();
    handler.handle.mockReturnValue(gate.promise);

    const first = worker.processNextJob();
    expect(await worker.processNextJob()).toBe(false);
    expect(queue.dequeue).toHaveBeenCalledTimes(1);
    expect(worker.getStats()).toEqual({ inFlight: 1, maxConcurrency: 1 });

    gate.resolve({ ok: true });
    expect(await first).toBe(true);
    expect(worker.getStats().inFlight).toBe(0);
    expect(queue.markSuccess).toHaveBeenCalledWith('j1', { ok: true });
  });

  it('runs up to the bound in parallel and leaves the rest in the queue', async () => {
    const worker = build(2);
    const gates = [deferred(), deferred(), deferred()];
    let next = 0;
    handler.handle.mockImplementation(() => gates[next++].promise);

    const a = worker.processNextJob();
    const b = worker.processNextJob();
    await flush();
    expect(handler.handle).toHaveBeenCalledTimes(2);

    // Saturated: the third call must not even dequeue.
    expect(await worker.processNextJob()).toBe(false);
    expect(queue.dequeue).toHaveBeenCalledTimes(2);
    expect(worker.getStats()).toEqual({ inFlight: 2, maxConcurrency: 2 });

    // A slot frees up, so the next call is admitted again.
    gates[0].resolve({});
    await a;
    expect(worker.getStats().inFlight).toBe(1);

    const c = worker.processNextJob();
    await flush();
    expect(queue.dequeue).toHaveBeenCalledTimes(3);
    expect(worker.getStats().inFlight).toBe(2);

    gates[1].resolve({});
    gates[2].resolve({});
    await Promise.all([b, c]);
    expect(worker.getStats().inFlight).toBe(0);
  });

  it('never exceeds the bound when many callers race for slots', async () => {
    const worker = build(3);
    const gates = Array.from({ length: 10 }, () => deferred());
    let next = 0;
    handler.handle.mockImplementation(() => gates[next++].promise);

    const attempts = Array.from({ length: 10 }, () => worker.processNextJob());
    await flush();

    expect(queue.dequeue).toHaveBeenCalledTimes(3);
    expect(worker.getStats().inFlight).toBe(3);

    gates.forEach((gate) => gate.resolve({}));
    const results = await Promise.all(attempts);
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(worker.getStats().inFlight).toBe(0);
  });

  it('releases the slot and records a retry when a handler fails', async () => {
    const worker = build(1);
    handler.handle.mockRejectedValueOnce(new Error('downstream unavailable'));

    expect(await worker.processNextJob()).toBe(true);

    expect(queue.markFailure).toHaveBeenCalledWith('j1', 'downstream unavailable');
    expect(worker.getStats().inFlight).toBe(0);

    // The freed slot lets the retry run.
    handler.handle.mockResolvedValueOnce({ ok: true });
    expect(await worker.processNextJob()).toBe(true);
    expect(queue.markSuccess).toHaveBeenCalledWith('j2', { ok: true });
  });

  it('releases the slot when no job is available', async () => {
    const worker = build(1);
    queue.dequeue.mockResolvedValueOnce(null);

    expect(await worker.processNextJob()).toBe(false);
    expect(worker.getStats().inFlight).toBe(0);
  });

  it('releases the slot when a job type has no registered handler', async () => {
    const worker = build(1);
    queue.dequeue.mockResolvedValueOnce({ ...job('orphan'), type: JobType.ORACLE_SYNC });

    expect(await worker.processNextJob()).toBe(true);

    expect(queue.markFailure).toHaveBeenCalledWith('orphan', `No handler for type ${JobType.ORACLE_SYNC}`);
    expect(worker.getStats().inFlight).toBe(0);
  });

  it('releases the slot when the queue itself throws', async () => {
    const worker = build(1);
    queue.dequeue.mockRejectedValueOnce(new Error('redis down'));

    await expect(worker.processNextJob()).rejects.toThrow('redis down');
    expect(worker.getStats().inFlight).toBe(0);
  });
});
