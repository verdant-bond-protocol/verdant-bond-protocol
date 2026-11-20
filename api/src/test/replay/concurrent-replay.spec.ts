/**
 * Deterministic replay tests for concurrent writes and retries (#390).
 *
 * Two write paths where concurrency and retries interact:
 *
 *   1. Nonce allocation (NonceService.withNonce): several submitters race for
 *      one account's sequence while the chain rejects, times out after
 *      commit, or fails before commit, and callers retry.
 *   2. Background queue admission (#391) and processing: several API
 *      instances enqueue concurrently against bounded capacity, an admin
 *      uses the privileged reserve, and two workers drain the queue while
 *      handlers fail and are retried.
 *
 * Each scenario runs across seeded interleavings (ReplayScheduler) and
 * asserts invariants after every step. Determinism is itself tested: a seed
 * reproduces its trace and final store byte for byte, and a recorded trace
 * replays to the same state. Reproduce one seed with
 *   REPLAY_SEED=2007 npx jest src/test/replay
 * See docs/runbooks/DETERMINISTIC_REPLAY.md.
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'crypto';
import { NonceService } from '../../common/services/nonce.service';
import { JobQueueService } from '../../workers/services/job-queue.service';
import { WorkerService } from '../../workers/services/worker.service';
import { QueueBackpressureException } from '../../workers/services/queue-backpressure';
import { Job, JobStatus, JobType } from '../../workers/interfaces/job.interface';
import { ChaosRedisClient, chaosRedisService, seededRandom } from '../chaos.harness';
import { ActorOutcome, ReplayDivergenceError, ReplayMode, ReplayScheduler, gatedClient } from './replay-scheduler';

beforeAll(() => Logger.overrideLogger(false));

const SEEDS = process.env.REPLAY_SEED
  ? [Number(process.env.REPLAY_SEED)]
  : Array.from({ length: 25 }, (_, i) => 2000 + i);

const ENV = {
  NONCE_LOCK_RETRY_MS: '50',
  NONCE_LOCK_WAIT_MS: '180000',
  JOB_QUEUE_MAX_DEPTH_DATA_EXPORT: '3',
  JOB_QUEUE_USER_MAX_DEPTH_DATA_EXPORT: '2',
};
const saved: Record<string, string | undefined> = {};

let uuidCounter = 0;
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  // setImmediate stays real: the scheduler uses it to drain microtasks.
  jest.useFakeTimers({ doNotFake: ['setImmediate'], now: 0 });
  uuidCounter = 0;
  // Job ids and lock tokens must not differ between two runs of one seed.
  jest
    .spyOn(crypto, 'randomUUID')
    .mockImplementation(() => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
  for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
});

const fail = (seed: number, scheduler: ReplayScheduler, message: string): never => {
  throw new Error(`seed ${seed}: ${message}\nreplay trace: ${JSON.stringify(scheduler.trace)}`);
};

// ── Scenario 1: concurrent nonce allocation with chain retries ──────────────

type ChainMode = 'ok' | 'failBefore' | 'failAfterCommit';

/** Stellar-like account sequence: a tx lands only with the current nonce. */
class Chain {
  sequence = 0;
  badSeq = 0;
  overlaps = 0;
  readonly committed = new Map<string, number>();
  /** Every sequence number consumed, in ledger order. */
  readonly landed: number[] = [];
  private inFlight = 0;

  constructor(private readonly scheduler: ReplayScheduler) {}

  async nonce(actor: string): Promise<number> {
    await this.scheduler.gate(actor, 'chain.nonce');
    return this.sequence;
  }

  async submit(actor: string, nonce: number, mode: ChainMode): Promise<string> {
    if (++this.inFlight > 1) this.overlaps++;
    try {
      await this.scheduler.gate(actor, 'chain.submit');
      if (mode === 'failBefore') throw new Error('rpc: connection reset');
      if (nonce !== this.sequence) {
        this.badSeq++;
        throw new Error('tx_bad_seq');
      }
      // Every landed tx consumes its sequence number. The payment itself is
      // idempotent at the business level: a re-signed retry of a payment that
      // already landed is a no-op, never a second payment.
      this.landed.push(nonce);
      this.sequence++;
      if (this.committed.has(actor)) return `tx-${actor}-${this.committed.get(actor)}`;
      this.committed.set(actor, nonce);
      if (mode === 'failAfterCommit') throw new Error('rpc: timeout after commit');
      return `tx-${actor}-${nonce}`;
    } finally {
      this.inFlight--;
    }
  }
}

const CONTRACT = 'CBOND';
const ACCOUNT = 'GISSUER';

async function nonceScenario(seed: number, mode: ReplayMode) {
  const store = new ChaosRedisClient();
  const scheduler = new ReplayScheduler(mode);
  const chain = new Chain(scheduler);
  const actors = ['sub-1', 'sub-2', 'sub-3', 'sub-4'];
  const MAX_ATTEMPTS = 3;

  const body = (actor: string, index: number) => async () => {
    const nonces = new NonceService(chaosRedisService(gatedClient(store, scheduler, actor)));
    // Per-actor fault stream: independent of how actors interleave.
    const rnd = seededRandom(seed * 101 + index);
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const roll = rnd();
      const chainMode: ChainMode = roll < 0.2 ? 'failBefore' : roll < 0.35 ? 'failAfterCommit' : 'ok';
      try {
        return await nonces.withNonce(
          CONTRACT,
          ACCOUNT,
          () => chain.nonce(actor),
          (nonce) => chain.submit(actor, nonce, chainMode),
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  const outcomes = await scheduler.run(Object.fromEntries(actors.map((a, i) => [a, body(a, i)])));
  return { store, scheduler, chain, outcomes, actors };
}

describe('replay: concurrent nonce allocation and retries (#390)', () => {
  it.each(SEEDS)('seed %i: one tx per submitter, contiguous sequence, cursor converges', async (seed) => {
    const { store, scheduler, chain, outcomes, actors } = await nonceScenario(seed, { seed });

    if (chain.overlaps !== 0) fail(seed, scheduler, `${chain.overlaps} overlapping submits under the nonce lock`);
    if (chain.badSeq !== 0) fail(seed, scheduler, `${chain.badSeq} tx_bad_seq rejections (stale cursor used)`);

    for (const actor of actors) {
      const outcome = outcomes[actor];
      if (outcome.kind === 'hung') fail(seed, scheduler, `${actor} never finished`);
      // Success means the payment landed exactly once.
      if (outcome.kind === 'ok' && !chain.committed.has(actor)) fail(seed, scheduler, `${actor} succeeded without a commit`);
    }

    // Sequence numbers are consumed in order with no gaps or reuse.
    expect(chain.landed).toEqual(chain.landed.map((_, i) => i));
    expect(chain.sequence).toBe(chain.landed.length);
    // Rollback/resync leaves the cached cursor on chain truth, and the lock free.
    expect(store.peek(`nonce:${CONTRACT}:${ACCOUNT}`)).toBe(String(chain.sequence));
    expect(store.peek(`nonce:${CONTRACT}:${ACCOUNT}:lock`)).toBeNull();
  });

  it('failure path: Redis loss mid-allocation surfaces 503 and never double-allocates', async () => {
    const store = new ChaosRedisClient();
    const scheduler = new ReplayScheduler({ seed: 7 });
    const chain = new Chain(scheduler);
    let failures = 0;
    store.plan = (op, key) => (op === 'set' && key.endsWith(':lock') && failures++ < 1 ? 'fail' : undefined);

    const make = (actor: string) => () =>
      new NonceService(chaosRedisService(gatedClient(store, scheduler, actor))).withNonce(
        CONTRACT,
        ACCOUNT,
        () => chain.nonce(actor),
        (n) => chain.submit(actor, n, 'ok'),
      );
    const outcomes = await scheduler.run({ a: make('a'), b: make('b') });

    const errors = Object.values(outcomes).filter((o) => o.kind === 'error') as Array<{ kind: 'error'; error: unknown }>;
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBeInstanceOf(ServiceUnavailableException);
    expect(chain.committed.size).toBe(1);
    expect(chain.badSeq).toBe(0);
  });
});

// ── Scenario 2: bounded queue admission + workers with retries ──────────────

const EXPORT_BOUND = 3;
const USER_BOUND = 2;

async function queueScenario(seed: number, mode: ReplayMode) {
  const store = new ChaosRedisClient();
  const scheduler = new ReplayScheduler(mode);
  const telemetry = { emit: () => undefined } as any;
  const running = new Set<string>();
  let overlaps = 0;
  let afterTerminal = 0;
  const reserve = 10; // DEFAULT_QUEUE_LIMITS data_export adminReserve

  const queueFor = (actor: string) => new JobQueueService(chaosRedisService(gatedClient(store, scheduler, actor)));

  /** Client with Retry-After honoured on the fake clock, at most 3 tries. */
  const submitter = (actor: string, userId: string, count: number, privileged = false) => async () => {
    const queue = queueFor(actor);
    const admitted: string[] = [];
    const rejected: string[] = [];
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; ; attempt++) {
        try {
          admitted.push((await queue.enqueue({ type: JobType.DATA_EXPORT, data: { i }, userId }, 2, { privileged })).id);
          break;
        } catch (error) {
          if (!(error instanceof QueueBackpressureException)) throw error;
          if (attempt === 2) {
            rejected.push(error.scope);
            break;
          }
          await new Promise((r) => setTimeout(r, error.retryAfterSeconds * 1000));
        }
      }
    }
    return { admitted, rejected };
  };

  const workerBody = (actor: string, faultStream: number, rounds: number) => async () => {
    const rnd = seededRandom(seed * 13 + faultStream);
    const queue = queueFor(actor);
    const worker = new WorkerService(queue, telemetry);
    let current: string | undefined;

    // Observe claims and releases so overlap is measured, not assumed.
    const dequeue = queue.dequeue.bind(queue);
    queue.dequeue = async () => {
      const job = await dequeue();
      if (job) {
        if (running.has(job.id)) overlaps++;
        running.add(job.id);
        current = job.id;
      }
      return job;
    };
    const markSuccess = queue.markSuccess.bind(queue);
    queue.markSuccess = async (id, result) => (running.delete(id), markSuccess(id, result));
    const markFailure = queue.markFailure.bind(queue);
    queue.markFailure = async (id, error) => (running.delete(id), markFailure(id, error));

    worker.registerHandler(JobType.DATA_EXPORT, {
      handle: async () => {
        await scheduler.gate(actor, 'handler');
        const raw = current ? store.peek(`job:${current}`) : null;
        const status = raw ? (JSON.parse(raw) as Job).status : undefined;
        if (status === JobStatus.SUCCESS || status === JobStatus.DEAD_LETTER) afterTerminal++;
        if (rnd() < 0.3) throw new Error('export backend: transient failure');
        return {};
      },
    });
    for (let i = 0; i < rounds; i++) await worker.processNextJob();
    return { admitted: [], rejected: [] };
  };

  scheduler.onStep = () => {
    const typeDepth = store.members('job:queue:type:data_export').length;
    if (typeDepth > EXPORT_BOUND + reserve) fail(seed, scheduler, `type depth ${typeDepth} exceeds bound + reserve`);
    for (const user of ['alice', 'bob']) {
      const depth = store.members(`job:queue:user:${user}`).length;
      if (depth > USER_BOUND) fail(seed, scheduler, `user ${user} holds ${depth} > ${USER_BOUND} pending jobs`);
    }
  };

  const outcomes = await scheduler.run({
    'api-1': submitter('api-1', 'alice', 3),
    'api-2': submitter('api-2', 'bob', 3),
    'api-3': submitter('api-3', 'alice', 1),
    admin: submitter('admin', 'ops', 2, true),
    'worker-a': workerBody('worker-a', 1, 14),
    'worker-b': workerBody('worker-b', 2, 14),
  });

  return { store, scheduler, outcomes, overlaps, afterTerminal };
}

type SubmitResult = { admitted: string[]; rejected: string[] };

describe('replay: bounded queue admission under concurrency and retries (#390, #391)', () => {
  it.each(SEEDS)('seed %i: bounds hold at every step, admitted work is never lost', async (seed) => {
    const { store, scheduler, outcomes, overlaps, afterTerminal } = await queueScenario(seed, { seed });

    for (const [actor, outcome] of Object.entries(outcomes)) {
      if (outcome.kind !== 'ok') {
        fail(seed, scheduler, `${actor} ended ${outcome.kind}: ${String((outcome as any).error)}`);
      }
    }
    if (overlaps !== 0) fail(seed, scheduler, `${overlaps} jobs ran on two workers at once`);
    if (afterTerminal !== 0) fail(seed, scheduler, `${afterTerminal} handler runs after a terminal status`);

    const results = outcomes as Record<string, { kind: 'ok'; value: SubmitResult }>;
    const admitted = Object.values(results).flatMap((o) => o.value.admitted);
    const rejectedScopes = Object.values(results).flatMap((o) => o.value.rejected);

    // Authorization path: the admin never loses to user saturation.
    expect(results.admin.value.admitted).toHaveLength(2);
    // Rejections only ever come from a real bound (or contention), and
    // nothing rejected was persisted.
    for (const scope of rejectedScopes) expect(['user', 'type', 'global', 'contended']).toContain(scope);
    const persisted = Object.keys(store.snapshot())
      .filter((k) => /^job:[0-9a-f-]{36}$/.test(k))
      .map((k) => k.slice('job:'.length));
    expect(persisted.sort()).toEqual([...admitted].sort());

    // Every admitted job is either still queued or terminal; terminal ones
    // are out of every admission index.
    const queued = new Set(store.members('job:queue'));
    for (const id of admitted) {
      const job = JSON.parse(store.peek(`job:${id}`)!) as Job;
      const terminal = job.status === JobStatus.SUCCESS || job.status === JobStatus.DEAD_LETTER;
      if (!terminal && !queued.has(id)) fail(seed, scheduler, `job ${id} (${job.status}) lost from the queue`);
      if (terminal) expect(store.members('job:queue:type:data_export')).not.toContain(id);
    }
    expect(store.peek('job:admission:lock')).toBeNull();
  });
});

// ── Determinism of the replay mechanism itself ──────────────────────────────

describe('replay mechanism', () => {
  const resetIds = () => {
    uuidCounter = 0;
    jest.setSystemTime(0);
  };

  it('a seed reproduces the same trace and final store', async () => {
    const first = await queueScenario(2003, { seed: 2003 });
    resetIds();
    const second = await queueScenario(2003, { seed: 2003 });
    expect(second.scheduler.trace).toEqual(first.scheduler.trace);
    expect(second.store.snapshot()).toEqual(first.store.snapshot());
  });

  it('a recorded trace replays to the same final store', async () => {
    const recorded = await nonceScenario(2011, { seed: 2011 });
    resetIds();
    const replayed = await nonceScenario(2011, { trace: recorded.scheduler.trace });
    expect(replayed.scheduler.trace).toEqual(recorded.scheduler.trace);
    expect(replayed.store.snapshot()).toEqual(recorded.store.snapshot());
    expect([...replayed.chain.committed]).toEqual([...recorded.chain.committed]);
  });

  it('different seeds explore different interleavings', async () => {
    const traces = new Set<string>();
    for (const seed of [2000, 2001, 2002, 2004]) {
      resetIds();
      traces.add(JSON.stringify((await nonceScenario(seed, { seed })).scheduler.trace));
    }
    expect(traces.size).toBeGreaterThan(1);
  });

  it('a trace that no longer matches the code fails loudly with the step', async () => {
    const recorded = await nonceScenario(2005, { seed: 2005 });
    resetIds();
    const tampered = [...recorded.scheduler.trace];
    tampered[3] = 'ghost#1:get';
    await expect(nonceScenario(2005, { trace: tampered })).rejects.toBeInstanceOf(ReplayDivergenceError);
  });

  it('reports actors that can never be scheduled as hung', async () => {
    const scheduler = new ReplayScheduler({ seed: 1 });
    const outcomes: Record<string, ActorOutcome<unknown>> = await scheduler.run({
      stuck: () => new Promise(() => undefined),
      fine: async () => 'done',
    });
    expect(outcomes.stuck.kind).toBe('hung');
    expect(outcomes.fine).toEqual({ kind: 'ok', value: 'done' });
  });
});
