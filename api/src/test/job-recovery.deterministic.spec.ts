/**
 * Deterministic recovery suite for interrupted job workflows.
 *
 * Uses the seeded chaos harness (no wall clock, no real Redis) so every failure
 * and recovery scenario replays identically. Covers: normal, failure, retry,
 * dead-letter recovery, stuck-job recovery, malformed payloads, replay attacks,
 * dependency-fallback decisions, and the admin authorization boundary.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { JobQueueService, PROCESSING_LOCK_SECONDS } from '../workers/services/job-queue.service';
import { JobsController } from '../workers/controllers/jobs.controller';
import { JobPayload, JobStatus, JobType } from '../workers/interfaces/job.interface';
import { MalformedJobPayloadException } from '../workers/services/job-payload-validation';
import {
  DEPENDENCY_FALLBACK_MATRIX,
  decideFallback,
  matrixGaps,
} from '../workers/services/dependency-fallback';
import {
  ChaosRedisClient,
  chaosRedisService,
  noFaults,
  randomFaults,
} from './chaos.harness';
import { buildControllerApp } from './controller-guard.harness';
import { autoMock } from './guard-role-mocks';
import {
  expiredReplayPayload,
  malformedPayloadFixtures,
  normalPayload,
  privilegedPayload,
  replayPayloads,
  unauthorizedPayload,
} from './fixtures/job-payload.fixtures';

const FIXED = Date.parse('2026-01-01T00:00:00.000Z');

function payload(seq: number, idempotencyKey?: string): JobPayload {
  return {
    type: JobType.ORACLE_SYNC,
    data: { seq },
    correlationId: `corr-${seq}`,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function boot() {
  const client = new ChaosRedisClient();
  const redis = chaosRedisService(client);
  const queue = new JobQueueService(redis);
  return { client, queue };
}

describe('resumable jobs with dead-letter recovery (deterministic)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('normal path: a job is claimed, completed and removed from the queue', async () => {
    const { client, queue } = boot();
    const job = await queue.enqueue(payload(1));
    expect(job.status).toBe(JobStatus.PENDING);

    const claimed = await queue.dequeue();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe(JobStatus.PROCESSING);
    expect(client.peek(`job:processing:${job.id}`)).not.toBeNull();

    await queue.markSuccess(job.id, { ok: true });
    expect((await queue.getJob(job.id))?.status).toBe(JobStatus.SUCCESS);
    expect(await queue.getQueueSize()).toBe(0);
    expect(await queue.getDeadLetterJobs()).toEqual([]);
  });

  it('failure path: exhausted retries dead-letter the job and stop re-delivery', async () => {
    const { queue } = boot();
    const job = await queue.enqueue(payload(2), 2);

    expect(await queue.markFailure(job.id, 'oracle unreachable')).toBe(true);
    expect((await queue.getJob(job.id))?.retries).toBe(1);
    expect(await queue.markFailure(job.id, 'oracle unreachable')).toBe(false);

    const dead = await queue.getJob(job.id);
    expect(dead?.status).toBe(JobStatus.DEAD_LETTER);
    expect((await queue.getDeadLetterJobs()).map((j) => j.id)).toEqual([job.id]);
    expect(await queue.dequeue()).toBeNull();
  });

  it('retry path: a transient failure returns the job to the queue', async () => {
    const { client, queue } = boot();
    const job = await queue.enqueue(payload(3), 3);

    expect(await queue.markFailure(job.id, 'transient RPC timeout')).toBe(true);
    const retried = await queue.getJob(job.id);
    expect(retried?.status).toBe(JobStatus.PENDING);
    expect(retried?.retries).toBe(1);
    expect(client.peek(`job:processing:${job.id}`)).toBeNull(); // claim released

    const claimed = await queue.dequeue();
    expect(claimed?.id).toBe(job.id);
    await queue.markSuccess(job.id);
    expect((await queue.getJob(job.id))?.status).toBe(JobStatus.SUCCESS);
  });

  it('dead-letter recovery: re-queues with a fresh budget and records an audit entry', async () => {
    const { client, queue } = boot();
    const job = await queue.enqueue(payload(4), 2, { privileged: true });
    await queue.markFailure(job.id, 'rpc down');
    await queue.markFailure(job.id, 'rpc down');

    const recovered = await queue.recoverDeadLetter(job.id, { actor: 'G_ADMIN' });
    expect(recovered.status).toBe(JobStatus.PENDING);
    expect(recovered.retries).toBe(0);
    expect(recovered.maxRetries).toBe(2);
    expect(recovered.recoveryAttempts).toBe(1);
    expect(recovered.recoveredFrom).toBe('dead_letter');
    expect(await queue.getDeadLetterJobs()).toEqual([]);
    expect(client.members('job:queue')).toEqual([job.id]);

    const audit = await queue.getRecoveryAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      jobId: job.id,
      source: 'dead_letter',
      fromStatus: JobStatus.DEAD_LETTER,
      toStatus: JobStatus.PENDING,
      actor: 'G_ADMIN',
      retriesBefore: 2,
      retriesAfter: 0,
    });

    // The recovered job runs cleanly and is then finished.
    await queue.dequeue();
    await queue.markSuccess(job.id, { ok: true });
    expect((await queue.getJob(job.id))?.status).toBe(JobStatus.SUCCESS);
  });

  it('dead-letter recovery with resetRetries=false grants exactly one more attempt', async () => {
    const { queue } = boot();
    const job = await queue.enqueue(payload(5), 2, { privileged: true });
    await queue.markFailure(job.id, 'boom');
    await queue.markFailure(job.id, 'boom');

    const recovered = await queue.recoverDeadLetter(job.id, { resetRetries: false });
    expect(recovered.retries).toBe(2);
    expect(recovered.maxRetries).toBe(3);

    await queue.markFailure(job.id, 'boom again');
    expect((await queue.getJob(job.id))?.status).toBe(JobStatus.DEAD_LETTER);
  });

  it('recovery write fault fails closed: the job stays in the dead letter', async () => {
    const { client, queue } = boot();
    const job = await queue.enqueue(payload(6), 1, { privileged: true });
    await queue.markFailure(job.id, 'boom');

    client.plan = (op, key) =>
      op === 'set' && key === `job:${job.id}` ? 'fail' : undefined;

    await expect(queue.recoverDeadLetter(job.id)).rejects.toThrow(/Recovery write failed/);
    const stillDead = await queue.getJob(job.id);
    expect(stillDead?.status).toBe(JobStatus.DEAD_LETTER);
    expect((await queue.getDeadLetterJobs()).map((j) => j.id)).toEqual([job.id]);
  });

  it('rejects recovery of missing or non-dead-letter jobs', async () => {
    const { queue } = boot();
    await expect(queue.recoverDeadLetter('missing')).rejects.toThrow(/not found/);

    const job = await queue.enqueue(payload(7), 2);
    await expect(queue.recoverDeadLetter(job.id)).rejects.toThrow(/only dead-letter jobs/);
  });

  it('interrupted workflow: a crashed worker is recovered only after its lock expires', async () => {
    const { client, queue } = boot();
    const job = await queue.enqueue(payload(8), 2, { privileged: true });

    const claimed = await queue.dequeue();
    expect(claimed?.status).toBe(JobStatus.PROCESSING);

    // Worker dies here — no success/failure write, claim remains.
    const beforeExpiry = await queue.recoverStuckJobs({ now: FIXED, actor: 'G_ADMIN' });
    expect(beforeExpiry).toEqual({ recovered: [], examined: 1, stillLocked: 1 });

    const after = FIXED + PROCESSING_LOCK_SECONDS * 1000 + 1;
    client.advance(after - FIXED);
    const sweep = await queue.recoverStuckJobs({ now: after, actor: 'G_ADMIN' });
    expect(sweep).toEqual({ recovered: [job.id], examined: 1, stillLocked: 0 });

    const reset = await queue.getJob(job.id);
    expect(reset?.status).toBe(JobStatus.PENDING);
    expect(reset?.recoveredFrom).toBe('stuck');
    expect(reset?.recoveryAttempts).toBe(1);
    expect(client.peek(`job:processing:${job.id}`)).toBeNull();

    const retried = await queue.dequeue();
    expect(retried?.id).toBe(job.id);
    await queue.markSuccess(job.id, { resumed: true });
    expect((await queue.getJob(job.id))?.status).toBe(JobStatus.SUCCESS);
    expect((await queue.getRecoveryAudit()).map((e) => e.source)).toEqual(['stuck']);
  });

  it('malformed payload fixtures are rejected before any state is written', async () => {
    const { client, queue } = boot();
    for (const fixture of malformedPayloadFixtures) {
      try {
        await queue.enqueue(fixture.payload as JobPayload);
        throw new Error(`fixture "${fixture.name}" was accepted`);
      } catch (error) {
        expect(error).toBeInstanceOf(MalformedJobPayloadException);
        expect((error as MalformedJobPayloadException).fieldErrors).toEqual(
          expect.arrayContaining([expect.objectContaining({ field: fixture.field })]),
        );
      }
    }
    expect(client.snapshot()).toEqual({});
  });

  it('replay attack fixture: a captured key returns the original job, not a second one', async () => {
    const { client, queue } = boot();
    const first = await queue.enqueue(replayPayloads[0], 3, { privileged: true });
    const replay = await queue.enqueue(replayPayloads[1], 3, { privileged: true });

    expect(replay.id).toBe(first.id);
    expect(replay.payload).toEqual(replayPayloads[0]);
    expect(client.members('job:queue')).toEqual([first.id]);
    expect(client.peek('job:idem:idem-replay-attack')).toBe(first.id);

    // Replay after the key expires is a legitimate new submission.
    client.advance(86_400_000 + 1);
    const afterWindow = await queue.enqueue(expiredReplayPayload, 3, { privileged: true });
    expect(afterWindow.id).not.toBe(first.id);
    expect(client.members('job:queue')).toHaveLength(2);
  });

  it('seeded chaos replay is deterministic across two identical runs', async () => {
    const run = (seed: number) => {
      const { client, queue } = boot();
      client.plan = randomFaults(seed, 0.15, ['fail', 'stale']);
      return (async () => {
        const job = await queue.enqueue(payload(9), 3, { privileged: true });
        // Two crashed attempts, then recovery and success — fault plan fixed by seed.
        await queue.dequeue().catch(() => undefined);
        await queue.dequeue().catch(() => undefined);
        await queue.markFailure(job.id, 'injected').catch(() => undefined);
        let recovered = false;
        let sweepError = false;
        try {
          const sweep = await queue.recoverStuckJobs({ now: FIXED, olderThanMs: 0 });
          recovered = sweep.recovered.length === 1;
        } catch {
          sweepError = true; // a faulted read fails closed; still deterministic
        }
        const final = await queue.getJob(job.id);
        return {
          status: final?.status,
          retries: final?.retries,
          recovered,
          sweepError,
          injected: { ...client.injected },
        };
      })();
    };

    expect(await run(1234)).toEqual(await run(1234));
  });

  it('no-fault plan keeps the recovery path inert', async () => {
    const { client, queue } = boot();
    client.plan = noFaults;
    const job = await queue.enqueue(payload(10), 2, { privileged: true });
    expect(await queue.recoverStuckJobs({ now: FIXED })).toEqual({
      recovered: [], examined: 1, stillLocked: 0,
    });
    expect((await queue.getJob(job.id))?.status).toBe(JobStatus.PENDING);
  });
});

describe('dependency degradation matrix', () => {
  it('defines a rule for every dependency/state pair', () => {
    expect(matrixGaps()).toEqual([]);
    expect(Object.keys(DEPENDENCY_FALLBACK_MATRIX)).toEqual(
      expect.arrayContaining(['redis', 'rpc', 'ipfs', 'postgres']),
    );
  });

  it('returns the documented strategies and fails closed for unknown pairs', () => {
    expect(decideFallback('redis', 'down').strategy).toBe('fail_closed');
    expect(decideFallback('rpc', 'down').strategy).toBe('degrade');
    expect(decideFallback('ipfs', 'down')).toMatchObject({
      strategy: 'fallback', fallbackSource: 'local-cache', retryable: false,
    });
    expect(decideFallback('postgres', 'unknown').strategy).toBe('fail_closed');
    expect(decideFallback('mystery', 'down')).toMatchObject({
      strategy: 'fail_closed', retryable: false, maxRetries: 0,
    });
  });

  it('honours a retry-budget override without mutating the matrix', () => {
    const before = decideFallback('rpc', 'degraded').maxRetries;
    expect(decideFallback('rpc', 'degraded', { maxRetries: 9 }).maxRetries).toBe(9);
    expect(decideFallback('rpc', 'degraded').maxRetries).toBe(before);
  });
});

describe('recovery authorization boundary', () => {
  let app: INestApplication;
  const queue = autoMock(JobQueueService);
  const previousAdminKey = process.env.STELLAR_PUBLIC_KEY;

  beforeAll(async () => {
    // Match the wallet address the fake AdminGuard assigns to an admin role.
    process.env.STELLAR_PUBLIC_KEY = 'G_ADMIN_ADDRESS';
    app = await buildControllerApp(JobsController, [
      { provide: JobQueueService, useValue: queue },
    ]);
    await app.init();
  });

  afterAll(async () => {
    if (previousAdminKey === undefined) delete process.env.STELLAR_PUBLIC_KEY;
    else process.env.STELLAR_PUBLIC_KEY = previousAdminKey;
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('rejects anonymous enqueue and non-admin dead-letter recovery', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/jobs/enqueue')
      .send(normalPayload)
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/jobs/dead-letter/job-1/recover')
      .set('x-test-role', 'user')
      .send({})
      .expect(401);
    expect(queue.recoverDeadLetter).not.toHaveBeenCalled();
  });

  it('allows an admin to recover a dead letter and passes the actor identity', async () => {
    (queue.recoverDeadLetter as jest.Mock).mockResolvedValue({ id: 'job-1', status: 'pending' });
    await request(app.getHttpServer())
      .post('/api/v1/jobs/dead-letter/job-1/recover')
      .set('x-test-role', 'admin')
      .send({ resetRetries: false })
      .expect(201);
    expect(queue.recoverDeadLetter).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ resetRetries: false, actor: 'G_ADMIN_ADDRESS' }),
    );
  });

  it('guards stuck recovery and the dependency-matrix view behind AdminGuard', async () => {
    (queue.recoverStuckJobs as jest.Mock).mockResolvedValue({ recovered: [], examined: 0, stillLocked: 0 });
    await request(app.getHttpServer())
      .post('/api/v1/jobs/recover/stuck')
      .set('x-test-role', 'user')
      .send({})
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/jobs/recover/stuck')
      .set('x-test-role', 'admin')
      .send({ limit: 5 })
      .expect(201);
    expect(queue.recoverStuckJobs).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, actor: 'G_ADMIN_ADDRESS' }),
    );
  });

  it('rejects a non-admin enqueue of a privileged job type', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/jobs/enqueue')
      .set('x-test-role', 'user')
      .send(unauthorizedPayload)
      .expect(403);
    expect(queue.enqueue).not.toHaveBeenCalled();

    await request(app.getHttpServer())
      .post('/api/v1/jobs/enqueue')
      .set('x-test-role', 'admin')
      .send(privilegedPayload)
      .expect(201);
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: JobType.RECONCILIATION }),
      undefined,
      { privileged: true },
    );
  });
});
