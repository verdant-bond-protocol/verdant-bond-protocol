/**
 * Deterministic chaos suite for interrupted user and background workflows (#348).
 *
 * User workflow:       Idempotency-Key protected mutation (IdempotencyInterceptor
 *                      + IdempotencyService) submitting to a ledger.
 * Background workflow: JobQueueService + WorkerService.
 *
 * Faults: connection resets, lost write acks, stale reads, process crashes and
 * restarts, handler (network) failures, client retries. Everything is driven by
 * seeded PRNGs and a manual clock; there are no sleeps or wall-clock timeouts,
 * so any failing seed replays identically. See docs/runbooks/CHAOS_TEST_SUITE.md.
 */
import { ConflictException, Logger } from '@nestjs/common';
import { lastValueFrom, from, Observable } from 'rxjs';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { IdempotencyService, IdempotencyRecord, RETRY_CLAIM_TTL_SECONDS } from '../common/services/idempotency.service';
import { JobQueueService, PROCESSING_LOCK_SECONDS } from '../workers/services/job-queue.service';
import { WorkerService } from '../workers/services/worker.service';
import { Job, JobStatus, JobType } from '../workers/interfaces/job.interface';
import {
  ChaosRedisClient,
  chaosRedisService,
  noFaults,
  randomFaults,
  seededRandom,
} from './chaos.harness';

beforeAll(() => Logger.overrideLogger(false));

const SEEDS = Array.from({ length: 25 }, (_, i) => 1000 + i);

/** Drains pending microtasks and fire-and-forget writes (no timers involved). */
const settle = () => new Promise((resolve) => setImmediate(resolve));

// ── User workflow model ─────────────────────────────────────────────────────

type Outcome = { kind: 'ok'; body: any } | { kind: 'conflict' } | { kind: 'error' } | { kind: 'crashed' };

interface Violations {
  overlapping: number;
  afterSuccess: number;
}

/**
 * A ledger that, like Stellar, deduplicates re-submissions of the same signed
 * transaction: a handler may run more than once (at-least-once), but the
 * on-chain effect for one idempotency key lands at most once.
 */
class Ledger {
  readonly committed = new Map<string, number>();
  readonly executions = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();
  readonly violations: Violations = { overlapping: 0, afterSuccess: 0 };

  constructor(private readonly redis: ChaosRedisClient) {}

  /** failAfterCommit: the tx lands but the submit call times out. */
  async submit(key: string, mode: 'ok' | 'failBefore' | 'failAfterCommit' | 'crash', onCrash: () => void) {
    const record = this.redis.peek(`idem:${key}`);
    if (record && (JSON.parse(record) as IdempotencyRecord).status === 'success') {
      this.violations.afterSuccess++;
    }
    const running = (this.inFlight.get(key) ?? 0) + 1;
    if (running > 1) this.violations.overlapping++;
    this.inFlight.set(key, running);
    const n = (this.executions.get(key) ?? 0) + 1;
    this.executions.set(key, n);

    try {
      await Promise.resolve(); // yield so concurrent requests interleave
      if (mode === 'failBefore') throw new Error('chain submit: connection reset');
      if (!this.committed.has(key)) this.committed.set(key, n);
      if (mode === 'crash') {
        onCrash();
        return new Promise<never>(() => undefined); // the process is gone
      }
      if (mode === 'failAfterCommit') throw new Error('chain submit: timeout after commit');
      return { transactionHash: `tx-${key}-${this.committed.get(key)}` };
    } finally {
      this.inFlight.set(key, (this.inFlight.get(key) ?? 1) - 1);
    }
  }
}

function httpContext(key: string, body: unknown) {
  const request = { method: 'POST', url: '/coupons/claim', originalUrl: '/coupons/claim', body, headers: { 'idempotency-key': key } };
  const response = { statusCode: 201 };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

/** One "process": a fresh service graph over the shared (durable) Redis. */
function bootApi(redis: ChaosRedisClient): IdempotencyInterceptor {
  const reflector = { getAllAndOverride: () => true } as any;
  return new IdempotencyInterceptor(reflector, new IdempotencyService(chaosRedisService(redis)));
}

async function request(
  api: IdempotencyInterceptor,
  ledger: Ledger,
  key: string,
  mode: Parameters<Ledger['submit']>[1],
): Promise<Outcome> {
  let crashed!: () => void;
  const crash = new Promise<Outcome>((resolve) => (crashed = () => resolve({ kind: 'crashed' })));
  const handler = { handle: (): Observable<any> => from(ledger.submit(key, mode, crashed)) };
  try {
    const obs = await api.intercept(httpContext(key, { bondId: 'bond-1', key }), handler);
    return await Promise.race([lastValueFrom(obs).then((body) => ({ kind: 'ok' as const, body })), crash]);
  } catch (err) {
    return err instanceof ConflictException ? { kind: 'conflict' } : { kind: 'error' };
  }
}

/**
 * Runbook step (CHAOS_TEST_SUITE.md, "wedged pending key"): a key stuck in
 * `pending` is resolved from ledger truth, never by blind re-execution.
 */
async function operatorRecover(redis: ChaosRedisClient, ledger: Ledger, keys: string[]): Promise<number> {
  const service = new IdempotencyService(chaosRedisService(redis));
  let recovered = 0;
  for (const key of keys) {
    const raw = redis.peek(`idem:${key}`);
    if (!raw || (JSON.parse(raw) as IdempotencyRecord).status !== 'pending') continue;
    recovered++;
    const n = ledger.committed.get(key);
    if (n !== undefined) {
      await service.complete(key, 'success', { transactionHash: `tx-${key}-${n}` }, 201);
    } else {
      redis.forceDelete(`idem:${key}`);
      redis.forceDelete(`idem:${key}:retry`);
    }
  }
  return recovered;
}

describe('chaos: idempotent user mutations', () => {
  let redis: ChaosRedisClient;
  let ledger: Ledger;

  beforeEach(() => {
    redis = new ChaosRedisClient();
    ledger = new Ledger(redis);
  });

  it('fails closed when a reserved key reads back stale/empty (no duplicate execution)', async () => {
    // The key holds a settled result, but every read returns the pre-write view (absent).
    await redis.set('idem:k', JSON.stringify({ status: 'success', fingerprint: 'f', result: {}, createdAt: 0 }));
    redis.plan = (op) => (op === 'get' ? 'stale' : undefined);

    expect((await request(bootApi(redis), ledger, 'k', 'ok')).kind).toBe('conflict');
    expect(ledger.executions.has('k')).toBe(false);
  });

  it('lets exactly one of many concurrent retries run after an error', async () => {
    const api = bootApi(redis);
    expect((await request(api, ledger, 'k', 'failBefore')).kind).toBe('error');
    await settle();

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => request(api, ledger, 'k', 'ok')),
    );
    await settle();

    expect(outcomes.filter((o) => o.kind === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'conflict')).toHaveLength(4);
    expect(ledger.executions.get('k')).toBe(2);
    expect(ledger.violations).toEqual({ overlapping: 0, afterSuccess: 0 });

    // The key is now settled: further retries replay, never re-execute.
    const replay = await request(api, ledger, 'k', 'ok');
    expect(replay).toEqual(outcomes.find((o) => o.kind === 'ok'));
    expect(ledger.executions.get('k')).toBe(2);
  });

  it('recognises its own reservation when the reservation ack is lost', async () => {
    redis.plan = (op, key) => (op === 'set' && key === 'idem:k' ? 'lostAck' : undefined);
    const outcome = await request(bootApi(redis), ledger, 'k', 'ok');
    expect(outcome.kind).toBe('ok');
    expect(ledger.executions.get('k')).toBe(1);
  });

  it('wedges a key in pending after a mid-request crash, then recovers from ledger truth', async () => {
    expect((await request(bootApi(redis), ledger, 'k', 'crash')).kind).toBe('crashed');

    // Restarted process: retries are refused, the mutation is never re-run.
    const api = bootApi(redis);
    expect((await request(api, ledger, 'k', 'ok')).kind).toBe('conflict');
    expect(ledger.executions.get('k')).toBe(1);

    expect(await operatorRecover(redis, ledger, ['k'])).toBe(1);
    const after = await request(api, ledger, 'k', 'ok');
    expect(after).toEqual({ kind: 'ok', body: { transactionHash: 'tx-k-1' } });
    expect(ledger.executions.get('k')).toBe(1);
  });

  it.each(SEEDS)('seed %i: safety under random faults, convergence after recovery', async (seed) => {
    const keys = ['a', 'b', 'c', 'd'];
    const rnd = seededRandom(seed);
    const pickMode = (): Parameters<Ledger['submit']>[1] => {
      const r = rnd();
      return r < 0.1 ? 'failBefore' : r < 0.18 ? 'failAfterCommit' : r < 0.22 ? 'crash' : 'ok';
    };
    redis.plan = randomFaults(seed, 0.15, ['fail', 'lostAck', 'stale']);
    const successBodies = new Map<string, string>();
    const recordOk = (key: string, o: Outcome) => {
      if (o.kind !== 'ok') return;
      const body = JSON.stringify(o.body);
      expect(successBodies.get(key) ?? body).toBe(body); // every client sees one result
      successBodies.set(key, body);
    };

    for (let round = 0; round < 6; round++) {
      const api = bootApi(redis); // restart each round
      const batch = keys.flatMap((key) => [0, 1, 2].map(() => ({ key, mode: pickMode() })));
      const outcomes = await Promise.all(batch.map(({ key, mode }) => request(api, ledger, key, mode)));
      outcomes.forEach((o, i) => recordOk(batch[i].key, o));
      await settle();
    }

    expect(ledger.violations).toEqual({ overlapping: 0, afterSuccess: 0 });

    // Faults stop; the runbook clears wedged keys; client retries converge.
    redis.plan = noFaults;
    await operatorRecover(redis, ledger, keys);
    redis.advance(RETRY_CLAIM_TTL_SECONDS * 1000); // orphaned retry claims lapse
    const api = bootApi(redis);
    for (const key of keys) {
      let outcome: Outcome = { kind: 'error' };
      for (let attempt = 0; attempt < 3 && outcome.kind !== 'ok'; attempt++) {
        outcome = await request(api, ledger, key, 'ok');
        await settle();
      }
      expect(outcome.kind).toBe('ok');
      recordOk(key, outcome);
      // The answer clients converge on is the transaction that actually landed.
      expect(successBodies.get(key)).toBe(JSON.stringify({ transactionHash: `tx-${key}-${ledger.committed.get(key)}` }));
    }
    expect(ledger.violations).toEqual({ overlapping: 0, afterSuccess: 0 });
    expect(redis.injected.fail + redis.injected.lostAck + redis.injected.stale).toBeGreaterThan(0);
  });
});

// ── Background workflow model ───────────────────────────────────────────────

describe('chaos: background job queue', () => {
  let redis: ChaosRedisClient;
  const telemetry = { emit: () => undefined } as any;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); // WorkerService arms a 5-minute timeout per job; never let it fire
    redis = new ChaosRedisClient();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const status = (id: string): JobStatus | undefined => {
    const raw = redis.peek(`job:${id}`);
    return raw ? (JSON.parse(raw) as Job).status : undefined;
  };
  const isDone = (id: string) => status(id) === JobStatus.SUCCESS || status(id) === JobStatus.DEAD_LETTER;

  function bootWorker(handle: (data: any) => Promise<Record<string, any>>) {
    const queue = new JobQueueService(chaosRedisService(redis));
    const worker = new WorkerService(queue, telemetry);
    worker.registerHandler(JobType.COUPON_DISTRIBUTION, { handle });
    return { queue, worker };
  }

  async function enqueue(count: number, maxRetries = 3): Promise<string[]> {
    const queue = new JobQueueService(chaosRedisService(redis));
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push((await queue.enqueue({ type: JobType.COUPON_DISTRIBUTION, data: { i } }, maxRetries)).id);
    }
    return ids;
  }

  it('never re-dispatches a completed job (regression: removal was a no-op sAdd)', async () => {
    const [id] = await enqueue(1);
    let runs = 0;
    const { worker } = bootWorker(async () => ({ runs: ++runs }));

    expect(await worker.processNextJob()).toBe(true);
    expect(await worker.processNextJob()).toBe(false);
    expect(runs).toBe(1);
    expect(status(id)).toBe(JobStatus.SUCCESS);
    expect(redis.members('job:queue')).toEqual([]);
  });

  it('redelivers a crashed worker\'s job only after its lock expires', async () => {
    const [id] = await enqueue(1);
    let runs = 0;
    const crashed = bootWorker(() => {
      runs++;
      return new Promise(() => undefined); // worker dies mid-job
    });
    void crashed.worker.processNextJob();
    await settle();

    const { worker } = bootWorker(async () => ({ runs: ++runs }));
    expect(await worker.processNextJob()).toBe(false); // still claimed
    redis.advance(PROCESSING_LOCK_SECONDS * 1000 - 1);
    expect(await worker.processNextJob()).toBe(false);
    redis.advance(1);
    expect(await worker.processNextJob()).toBe(true);
    expect(runs).toBe(2);
    expect(status(id)).toBe(JobStatus.SUCCESS);
  });

  it('keeps a job whose terminal status write failed, and finishes it later', async () => {
    const [id] = await enqueue(1);
    let runs = 0;
    let failNextJobWrite = false;
    redis.plan = (op, key) => {
      if (failNextJobWrite && op === 'set' && key === `job:${id}`) {
        failNextJobWrite = false;
        return 'fail';
      }
      return undefined;
    };
    const { worker } = bootWorker(async () => {
      failNextJobWrite = ++runs === 1; // only the first completion write is lost
      return {};
    });

    await worker.processNextJob();
    expect(status(id)).toBe(JobStatus.PROCESSING);
    expect(redis.members('job:queue')).toEqual([id]); // not lost

    redis.advance(PROCESSING_LOCK_SECONDS * 1000);
    await worker.processNextJob();
    expect(status(id)).toBe(JobStatus.SUCCESS);
    expect(runs).toBe(2); // at-least-once
  });

  it('lists exhausted jobs as dead letters and stops retrying them', async () => {
    const [id] = await enqueue(1, 2);
    const { worker, queue } = bootWorker(async () => {
      throw new Error('oracle unreachable');
    });
    await worker.processNextJob();
    await worker.processNextJob();
    expect(await worker.processNextJob()).toBe(false);
    expect((await queue.getDeadLetterJobs()).map((j) => j.id)).toEqual([id]);
  });

  it.each(SEEDS)('seed %i: every job terminates, none re-runs after finishing', async (seed) => {
    const ids = await enqueue(5);
    const rnd = seededRandom(seed * 7919);
    const runs = new Map<string, number>();
    let inFlight = 0;
    const violations = { overlapping: 0, afterTerminal: 0 };

    let hung = false;
    let current = '';
    const handle = async () => {
      const id = current;
      if (isDone(id)) violations.afterTerminal++;
      runs.set(id, (runs.get(id) ?? 0) + 1);
      if (++inFlight > 1) violations.overlapping++;
      await Promise.resolve();
      const r = rnd();
      if (r < 0.1) {
        hung = true; // worker process dies mid-job
        return new Promise<never>(() => undefined);
      }
      inFlight--;
      if (r < 0.3) throw new Error('settlement RPC failed');
      return { ok: true };
    };

    redis.plan = randomFaults(seed, 0.1, ['fail', 'lostAck', 'stale']);
    for (let step = 0; step < 400 && !ids.every(isDone); step++) {
      if (step === 300) redis.plan = noFaults; // bound the fault window; liveness must follow
      const { worker, queue } = bootWorker(handle); // a fresh process every step
      const dequeue = queue.dequeue.bind(queue);
      queue.dequeue = async () => {
        const job = await dequeue();
        current = job?.id ?? '';
        return job;
      };

      hung = false;
      const run = worker.processNextJob().catch(() => undefined); // Redis errors surface here
      await settle();
      if (hung) inFlight = 0; // the process is gone; its lock remains until TTL
      else await run;
      redis.advance(60_000);
    }

    expect(ids.filter((id) => !isDone(id))).toEqual([]);
    expect(violations).toEqual({ overlapping: 0, afterTerminal: 0 });

    // Final sweep (no faults): queue drains, dead-letter listing is complete.
    redis.plan = noFaults;
    const { queue } = bootWorker(async () => ({}));
    expect(await queue.dequeue()).toBeNull();
    expect(redis.members('job:queue')).toEqual([]);
    const dead = ids.filter((id) => status(id) === JobStatus.DEAD_LETTER).sort();
    expect((await queue.getDeadLetterJobs()).map((j) => j.id).sort()).toEqual(dead);
  });
});
