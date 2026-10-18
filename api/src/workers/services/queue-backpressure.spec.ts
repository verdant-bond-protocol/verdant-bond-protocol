/**
 * Bounded queue backpressure (#391): normal, failure, retry and
 * authorization paths. Runs the real JobQueueService/RedisService over the
 * deterministic in-memory chaos client, so degrade semantics are production's.
 */
import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { JobQueueService } from './job-queue.service';
import { WorkerService } from './worker.service';
import {
  DEFAULT_QUEUE_LIMITS,
  QueueBackpressureException,
  decideAdmission,
  resolveQueueLimits,
} from './queue-backpressure';
import { JobsController } from '../controllers/jobs.controller';
import { ExportsController } from '../../exports/controllers/exports.controller';
import { JobStatus, JobType } from '../interfaces/job.interface';
import { ChaosRedisClient, chaosRedisService } from '../../test/chaos.harness';
import { Rfc7807ExceptionFilter } from '../../common/filters/rfc7807-exception.filter';
import { ErrorCode } from '../../common/errors/error-codes';

beforeAll(() => Logger.overrideLogger(false));

const ENV_KEYS = [
  'JOB_QUEUE_BACKPRESSURE',
  'JOB_QUEUE_MAX_DEPTH',
  'JOB_QUEUE_ADMIN_RESERVE',
  'JOB_QUEUE_MAX_DEPTH_DATA_EXPORT',
  'JOB_QUEUE_USER_MAX_DEPTH_DATA_EXPORT',
  'STELLAR_PUBLIC_KEY',
];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => ENV_KEYS.forEach((k) => (savedEnv[k] = process.env[k])));
afterEach(() =>
  ENV_KEYS.forEach((k) => (savedEnv[k] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[k]))),
);

/** Queue whose lock-retry pause resolves immediately (no timers). */
class TestQueue extends JobQueueService {
  pauses = 0;
  protected pause(): Promise<void> {
    this.pauses++;
    return Promise.resolve();
  }
}

const telemetry = { emit: () => undefined } as any;
const exportJob = (userId?: string) => ({ type: JobType.DATA_EXPORT, data: {}, userId });

async function rejection(promise: Promise<unknown>): Promise<QueueBackpressureException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof QueueBackpressureException) return error;
    throw error;
  }
  throw new Error('expected QueueBackpressureException');
}

describe('decideAdmission (pure bounds)', () => {
  const limits = DEFAULT_QUEUE_LIMITS;
  const t = limits.types[JobType.DATA_EXPORT];

  it('admits below every bound', () => {
    expect(decideAdmission(limits, JobType.DATA_EXPORT, { global: 0, type: 0, user: 0 }, false)).toEqual({ admitted: true });
  });

  it('rejects at exactly the per-user bound, tightest scope first', () => {
    const d = decideAdmission(limits, JobType.DATA_EXPORT, { global: 999, type: 99, user: t.perUserMaxDepth }, false);
    expect(d).toEqual({ admitted: false, scope: 'user', depth: t.perUserMaxDepth, limit: t.perUserMaxDepth });
  });

  it('rejects at the type bound and lets privileged callers use the reserve', () => {
    const atBound = { global: 0, type: t.maxDepth, user: 0 };
    expect(decideAdmission(limits, JobType.DATA_EXPORT, atBound, false).scope).toBe('type');
    expect(decideAdmission(limits, JobType.DATA_EXPORT, atBound, true).admitted).toBe(true);
    const reserveFull = { global: 0, type: t.maxDepth + t.adminReserve, user: 0 };
    expect(decideAdmission(limits, JobType.DATA_EXPORT, reserveFull, true)).toMatchObject({ admitted: false, scope: 'type' });
  });

  it('rejects at the global bound, with privileged headroom', () => {
    const full = { global: limits.globalMaxDepth, type: 0, user: 0 };
    expect(decideAdmission(limits, JobType.DATA_EXPORT, full, false).scope).toBe('global');
    expect(decideAdmission(limits, JobType.DATA_EXPORT, full, true).admitted).toBe(true);
  });

  it('privileged callers are not subject to the per-user bound', () => {
    expect(decideAdmission(limits, JobType.DATA_EXPORT, { global: 0, type: 0, user: 1_000 }, true).admitted).toBe(true);
  });
});

describe('resolveQueueLimits', () => {
  it('applies overrides and keeps defaults for malformed values', () => {
    const limits = resolveQueueLimits({
      JOB_QUEUE_MAX_DEPTH: '7',
      JOB_QUEUE_MAX_DEPTH_DATA_EXPORT: '2',
      JOB_QUEUE_USER_MAX_DEPTH_DATA_EXPORT: 'lots',
      JOB_QUEUE_ADMIN_RESERVE: '-4',
    });
    expect(limits.enabled).toBe(true);
    expect(limits.globalMaxDepth).toBe(7);
    expect(limits.types[JobType.DATA_EXPORT].maxDepth).toBe(2);
    expect(limits.types[JobType.DATA_EXPORT].perUserMaxDepth).toBe(DEFAULT_QUEUE_LIMITS.types[JobType.DATA_EXPORT].perUserMaxDepth);
    expect(limits.globalAdminReserve).toBe(DEFAULT_QUEUE_LIMITS.globalAdminReserve);
  });

  it('JOB_QUEUE_BACKPRESSURE=off is the rollback switch', () => {
    expect(resolveQueueLimits({ JOB_QUEUE_BACKPRESSURE: 'off' }).enabled).toBe(false);
  });
});

describe('JobQueueService admission', () => {
  let redis: ChaosRedisClient;
  const queue = () => new TestQueue(chaosRedisService(redis));

  beforeEach(() => {
    redis = new ChaosRedisClient();
    process.env.JOB_QUEUE_MAX_DEPTH_DATA_EXPORT = '3';
    process.env.JOB_QUEUE_USER_MAX_DEPTH_DATA_EXPORT = '2';
  });

  it('normal path: admits up to the bound, then answers 429 without persisting', async () => {
    const q = queue();
    await q.enqueue(exportJob('alice'));
    await q.enqueue(exportJob('alice'));
    await q.enqueue(exportJob('bob'));

    const err = await rejection(q.enqueue(exportJob('carol')));
    expect(err.getStatus()).toBe(429);
    expect(err.scope).toBe('type');
    expect(err.retryAfterSeconds).toBe(DEFAULT_QUEUE_LIMITS.types[JobType.DATA_EXPORT].retryAfterSeconds);
    expect(redis.members('job:queue')).toHaveLength(3);
    expect(redis.members('job:queue:type:data_export')).toHaveLength(3);
  });

  it('per-user bound stops one caller from taking the whole type budget', async () => {
    const q = queue();
    await q.enqueue(exportJob('alice'));
    await q.enqueue(exportJob('alice'));
    expect((await rejection(q.enqueue(exportJob('alice')))).scope).toBe('user');
    await expect(q.enqueue(exportJob('bob'))).resolves.toMatchObject({ status: JobStatus.PENDING });
  });

  it('types are bounded independently', async () => {
    const q = queue();
    for (const u of ['a', 'b', 'c']) await q.enqueue(exportJob(u));
    await expect(q.enqueue({ type: JobType.PORTFOLIO_REBALANCE, data: {}, userId: 'a' })).resolves.toBeDefined();
  });

  it('authorization path: privileged submissions use the reserve and skip the user bound', async () => {
    const q = queue();
    for (const u of ['a', 'b', 'c']) await q.enqueue(exportJob(u));
    expect((await rejection(q.enqueue(exportJob('d')))).scope).toBe('type');

    const reserve = DEFAULT_QUEUE_LIMITS.types[JobType.DATA_EXPORT].adminReserve;
    for (let i = 0; i < reserve; i++) {
      await q.enqueue(exportJob('admin'), undefined, { privileged: true });
    }
    expect((await rejection(q.enqueue(exportJob('admin'), undefined, { privileged: true }))).scope).toBe('type');
    // Privileged jobs never count against a user budget.
    expect(redis.members('job:queue:user:admin')).toEqual([]);
  });

  it('frees capacity when a job finishes or dead-letters', async () => {
    const q = queue();
    const jobs = [];
    for (const u of ['a', 'b', 'c']) jobs.push(await q.enqueue(exportJob(u)));
    await rejection(q.enqueue(exportJob('d')));

    await q.markSuccess(jobs[0].id);
    await q.enqueue(exportJob('d'));

    // Dead-letter path: one attempt only.
    const dl = await q.enqueue(exportJob('e'), 1, { privileged: true });
    await q.markFailure(dl.id, 'boom');
    expect(redis.members('job:queue:type:data_export')).not.toContain(dl.id);
    expect(redis.members('job:queue:user:a')).toEqual([]);
  });

  it('retry path: a re-queued retry is never shed, even when the queue is full', async () => {
    const q = queue();
    const first = await q.enqueue(exportJob('a'));
    await q.enqueue(exportJob('b'));
    await q.enqueue(exportJob('c'));

    const worker = new WorkerService(q, telemetry);
    let calls = 0;
    worker.registerHandler(JobType.DATA_EXPORT, {
      handle: async () => {
        calls++;
        if (calls === 1) throw new Error('transient');
        return {};
      },
    });
    // Whichever job ran first failed and was re-queued without admission.
    expect(await worker.processNextJob()).toBe(true);
    expect(redis.members('job:queue')).toHaveLength(3);
    expect(redis.members('job:queue:type:data_export')).toHaveLength(3);
    // ...and new work is still bounded.
    await rejection(q.enqueue(exportJob('d')));
    void first;
  });

  it('recovery: stale index entries (lost cleanup writes, expired records) are pruned before rejecting', async () => {
    const q = queue();
    const jobs = [];
    for (const u of ['a', 'b', 'c']) jobs.push(await q.enqueue(exportJob(u)));

    // Simulate a crash between the terminal write and index cleanup, and a
    // job record that expired while still indexed.
    const done = JSON.parse(redis.peek(`job:${jobs[0].id}`)!);
    await redis.set(`job:${jobs[0].id}`, JSON.stringify({ ...done, status: JobStatus.SUCCESS }));
    redis.forceDelete(`job:${jobs[1].id}`);

    await expect(q.enqueue(exportJob('d'))).resolves.toBeDefined();
    expect(redis.members('job:queue:type:data_export')).not.toContain(jobs[0].id);
    expect(redis.members('job:queue:type:data_export')).not.toContain(jobs[1].id);
  });

  it('recovery: pruning keeps a dead letter listed even if its dead-letter write was lost', async () => {
    const q = queue();
    const jobs = [];
    for (const u of ['a', 'b', 'c']) jobs.push(await q.enqueue(exportJob(u)));
    const rec = JSON.parse(redis.peek(`job:${jobs[0].id}`)!);
    await redis.set(`job:${jobs[0].id}`, JSON.stringify({ ...rec, status: JobStatus.DEAD_LETTER }));

    await q.enqueue(exportJob('d'));
    expect(redis.members('job:queue')).not.toContain(jobs[0].id);
    expect(redis.members('job:dead-letter')).toContain(jobs[0].id);
  });

  it('failure path: fails closed (503) when Redis cannot report depth', async () => {
    const q = queue();
    redis.plan = (op) => (op === 'sMembers' ? 'fail' : undefined);
    await expect(q.enqueue(exportJob('a'))).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(redis.members('job:queue')).toEqual([]);
  });

  it('failure path: contended admission lock retries, then answers 429 "contended"', async () => {
    const q = queue();
    await redis.set('job:admission:lock', 'someone-else', { PX: 5_000 });
    const err = await rejection(q.enqueue(exportJob('a')));
    expect(err.scope).toBe('contended');
    expect(q.pauses).toBe(5);
  });

  it('recovery: a crashed holder\'s admission lock self-expires', async () => {
    const q = queue();
    await redis.set('job:admission:lock', 'crashed-instance', { PX: 5_000 });
    redis.advance(5_000);
    await expect(q.enqueue(exportJob('a'))).resolves.toBeDefined();
    expect(redis.peek('job:admission:lock')).toBeNull();
  });

  it('rollback: JOB_QUEUE_BACKPRESSURE=off restores unbounded enqueue', async () => {
    process.env.JOB_QUEUE_BACKPRESSURE = 'off';
    const q = queue();
    for (let i = 0; i < 6; i++) await q.enqueue(exportJob('a'));
    expect(redis.members('job:queue')).toHaveLength(6);
  });

  it('reports per-type saturation for operators', async () => {
    const q = queue();
    for (const u of ['a', 'b', 'c']) await q.enqueue(exportJob(u));
    const status = await q.getBackpressureStatus();
    expect(status.types[JobType.DATA_EXPORT]).toMatchObject({ depth: 3, maxDepth: 3, saturated: true });
    expect(status.types[JobType.RECONCILIATION].saturated).toBe(false);
    expect(status.global.depth).toBe(3);
  });
});

describe('JobsController authorization (#391)', () => {
  const ADMIN = 'GADMINADMINADMINADMINADMINADMINADMINADMINADMINADMINADMIN';
  let redis: ChaosRedisClient;
  let controller: JobsController;

  beforeEach(() => {
    redis = new ChaosRedisClient();
    process.env.STELLAR_PUBLIC_KEY = ADMIN;
    controller = new JobsController(new TestQueue(chaosRedisService(redis)));
  });

  it('non-admins may enqueue self-service types only', async () => {
    const req = { user: { walletAddress: 'GUSER' } };
    await expect(controller.enqueueJob({ type: JobType.DATA_EXPORT, data: {} }, req)).resolves.toBeDefined();
    await expect(
      controller.enqueueJob({ type: JobType.COUPON_DISTRIBUTION, data: {} }, req),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the budget owner comes from the token, not the body', async () => {
    const job = await controller.enqueueJob(
      { type: JobType.DATA_EXPORT, data: {}, userId: 'victim' },
      { user: { walletAddress: 'GATTACKER' } },
    );
    expect(job.payload.userId).toBe('GATTACKER');
    expect(redis.members('job:queue:user:GATTACKER')).toEqual([job.id]);
    expect(redis.members('job:queue:user:victim')).toEqual([]);
  });

  it('admins may enqueue any type, as privileged', async () => {
    const job = await controller.enqueueJob(
      { type: JobType.COUPON_DISTRIBUTION, data: {} },
      { user: { walletAddress: ADMIN } },
    );
    expect(job.admittedFor).toBeUndefined();
  });
});

describe('ExportsController under backpressure', () => {
  it('cancels the export record when its job is not admitted', async () => {
    const exportService = {
      createExport: jest.fn().mockResolvedValue({ id: 'exp-1' }),
      cancelExport: jest.fn().mockResolvedValue({}),
    };
    const jobQueue = {
      enqueue: jest.fn().mockRejectedValue(new QueueBackpressureException(JobType.DATA_EXPORT, 'user', 60, 3, 3)),
    };
    const controller = new ExportsController(exportService as any, jobQueue as any);
    await expect(
      controller.requestExport({ user: { sub: 'u1', role: 'investor' } }, { exportType: 'holdings' as any }),
    ).rejects.toBeInstanceOf(QueueBackpressureException);
    expect(exportService.cancelExport).toHaveBeenCalledWith('exp-1', 'u1', 'investor');
  });
});

describe('RFC 7807 mapping of backpressure', () => {
  it('returns 429, QUEUE_BACKPRESSURE, retryable, and a Retry-After header', () => {
    const json = jest.fn();
    const response = { status: jest.fn().mockReturnValue({ json }), setHeader: jest.fn() };
    const host = {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ url: '/api/v1/jobs/enqueue' }) }),
    } as any;

    new Rfc7807ExceptionFilter().catch(new QueueBackpressureException(JobType.DATA_EXPORT, 'type', 60, 3, 3), host);

    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(json.mock.calls[0][0]).toMatchObject({ code: ErrorCode.QUEUE_BACKPRESSURE, retryable: true, status: 429 });
  });
});
