import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RedisService } from '../../common/services/redis.service';
import {
  Job,
  JobPayload,
  JobStatus,
  JobType,
  DEFAULT_MAX_RETRIES,
  JOB_PROCESSING_TIMEOUT_MS,
} from '../interfaces/job.interface';
import { validateJobPayload } from './job-payload-validation';
import {
  JobRecoveryAuditEntry,
  RecoverDeadLetterOptions,
  RecoverStuckOptions,
  RecoverySource,
  StuckRecoveryResult,
} from '../interfaces/job-recovery.interface';
import {
  ADMISSION_LOCK_ATTEMPTS,
  ADMISSION_LOCK_RETRY_MS,
  ADMISSION_LOCK_TTL_MS,
  QueueBackpressureException,
  QueueLimits,
  decideAdmission,
  resolveQueueLimits,
} from './queue-backpressure';
import * as crypto from 'crypto';

/** Must exceed JOB_PROCESSING_TIMEOUT_MS so a live job is never double-claimed. */
export const PROCESSING_LOCK_SECONDS = 600;

/** How long an idempotency key suppresses a replayed enqueue (24 hours). */
export const IDEMPOTENCY_TTL_SECONDS = 86_400;

/** Default cap for a single recovery sweep / audit read. */
export const DEFAULT_RECOVERY_LIMIT = 100;

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const isTerminal = (job: Job): boolean =>
  job.status === JobStatus.SUCCESS || job.status === JobStatus.DEAD_LETTER;

export interface EnqueueOptions {
  /**
   * Admin/system submission (#391): skips the per-user bound and may use the
   * reserved headroom above the type and global bounds.
   */
  privileged?: boolean;
}

export interface QueueTypeStatus {
  depth: number;
  maxDepth: number;
  adminReserve: number;
  saturated: boolean;
}

export interface BackpressureStatus {
  enabled: boolean;
  global: { depth: number; maxDepth: number; adminReserve: number; saturated: boolean };
  types: Record<JobType, QueueTypeStatus>;
}

@Injectable()
export class JobQueueService {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly QUEUE_KEY = 'job:queue';
  private readonly JOB_KEY_PREFIX = 'job:';
  private readonly PROCESSING_KEY_PREFIX = 'job:processing:';
  private readonly DEAD_LETTER_KEY = 'job:dead-letter';
  // Admission indexes (#391): pending job ids per type and per submitting user.
  private readonly TYPE_INDEX_PREFIX = 'job:queue:type:';
  private readonly USER_INDEX_PREFIX = 'job:queue:user:';
  private readonly ADMISSION_LOCK_KEY = 'job:admission:lock';
  // Recovery / replay-protection keys (additive; safe against older records).
  private readonly IDEMPOTENCY_PREFIX = 'job:idem:';
  private readonly RECOVERY_LOCK_KEY = 'job:recovery:lock';
  private readonly RECOVERY_AUDIT_KEY = 'job:recovery:audit';

  private readonly limits: QueueLimits;
  private readonly idempotencyTtlSeconds: number;

  constructor(private readonly redis: RedisService) {
    this.limits = resolveQueueLimits();
    this.idempotencyTtlSeconds = positiveInt(
      process.env.JOB_IDEMPOTENCY_TTL_SECONDS,
      IDEMPOTENCY_TTL_SECONDS,
    );
  }

  /**
   * Admit and persist a job, or throw {@link QueueBackpressureException}
   * (429) when a bound is reached. Admission runs under one short Redis lock
   * so concurrent API instances cannot jointly overshoot a bound; it fails
   * closed (503) when Redis cannot report queue depth.
   */
  async enqueue(
    payload: JobPayload,
    maxRetries = DEFAULT_MAX_RETRIES,
    options: EnqueueOptions = {},
  ): Promise<Job> {
    // Reject malformed payloads before any state is written (#malformed-fixtures).
    validateJobPayload(payload);

    // Replay suppression: a captured (type,data,key) request must return the
    // original job rather than enqueue a second one. The pre-check is an
    // optimisation; the atomic claim in persistNewJob is the real guard.
    const idemKey = payload.idempotencyKey;
    if (idemKey) {
      const existing = await this.getIdempotentJob(idemKey);
      if (existing) {
        this.logger.warn(`Replayed enqueue suppressed (key=${idemKey}, job=${existing.id})`);
        return existing;
      }
    }

    if (!this.limits.enabled) return this.persistNewJob(payload, maxRetries, undefined, idemKey);

    const token = crypto.randomUUID();
    if (!(await this.acquireAdmission(token))) {
      throw new QueueBackpressureException(payload.type, 'contended', 1);
    }
    try {
      const privileged = options.privileged === true;
      const userId = privileged ? undefined : payload.userId;
      const typeLimit = this.limits.types[payload.type];
      if (!typeLimit) {
        throw new BadRequestException(`Unknown job type: ${payload.type}`);
      }

      let depths = await this.readDepths(payload.type, userId);
      let decision = decideAdmission(this.limits, payload.type, depths, privileged);
      if (!decision.admitted) {
        // Indexes are cleaned up best-effort on completion; drop stale ids
        // (expired or finished jobs) before turning a caller away.
        await this.pruneIndexes(payload.type, userId);
        depths = await this.readDepths(payload.type, userId);
        decision = decideAdmission(this.limits, payload.type, depths, privileged);
      }
      if (!decision.admitted) {
        this.logger.warn(
          `Backpressure: rejected ${payload.type} job (scope=${decision.scope} depth=${decision.depth} limit=${decision.limit})`,
        );
        throw new QueueBackpressureException(
          payload.type,
          decision.scope!,
          typeLimit.retryAfterSeconds,
          decision.depth,
          decision.limit,
        );
      }

      return await this.persistNewJob(payload, maxRetries, userId, idemKey);
    } finally {
      await this.redis.releaseLockOrThrow(this.ADMISSION_LOCK_KEY, token).catch(() => undefined);
    }
  }

  async getBackpressureStatus(): Promise<BackpressureStatus> {
    const globalDepth = (await this.redis.sMembers(this.QUEUE_KEY)).length;
    const types = {} as Record<JobType, QueueTypeStatus>;
    for (const type of Object.values(JobType)) {
      const limit = this.limits.types[type];
      const depth = (await this.redis.sMembers(`${this.TYPE_INDEX_PREFIX}${type}`)).length;
      types[type] = {
        depth,
        maxDepth: limit.maxDepth,
        adminReserve: limit.adminReserve,
        saturated: depth >= limit.maxDepth,
      };
    }
    return {
      enabled: this.limits.enabled,
      global: {
        depth: globalDepth,
        maxDepth: this.limits.globalMaxDepth,
        adminReserve: this.limits.globalAdminReserve,
        saturated: globalDepth >= this.limits.globalMaxDepth,
      },
      types,
    };
  }

  private async acquireAdmission(token: string): Promise<boolean> {
    for (let attempt = 0; attempt < ADMISSION_LOCK_ATTEMPTS; attempt++) {
      if (await this.redis.acquireLockOrThrow(this.ADMISSION_LOCK_KEY, token, ADMISSION_LOCK_TTL_MS)) {
        return true;
      }
      await this.pause(ADMISSION_LOCK_RETRY_MS);
    }
    return false;
  }

  protected pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async readDepths(type: JobType, userId?: string) {
    return {
      global: (await this.redis.sMembersOrThrow(this.QUEUE_KEY)).length,
      type: (await this.redis.sMembersOrThrow(`${this.TYPE_INDEX_PREFIX}${type}`)).length,
      user: userId ? (await this.redis.sMembersOrThrow(`${this.USER_INDEX_PREFIX}${userId}`)).length : 0,
    };
  }

  private async pruneIndexes(type: JobType, userId?: string): Promise<void> {
    const keys = [this.QUEUE_KEY, `${this.TYPE_INDEX_PREFIX}${type}`];
    if (userId) keys.push(`${this.USER_INDEX_PREFIX}${userId}`);
    for (const key of keys) {
      for (const jobId of await this.redis.sMembersOrThrow(key)) {
        const raw = await this.redis.getOrThrow(`${this.JOB_KEY_PREFIX}${jobId}`);
        const job = raw ? (JSON.parse(raw) as Job) : null;
        if (job && !isTerminal(job)) continue;
        // Same repair dequeue() makes: a dead letter must stay listed.
        if (job?.status === JobStatus.DEAD_LETTER) await this.redis.sAdd(this.DEAD_LETTER_KEY, jobId);
        await this.redis.sRem(key, jobId);
      }
    }
  }

  private async removeFromIndexes(job: Job): Promise<void> {
    await this.redis.sRem(`${this.TYPE_INDEX_PREFIX}${job.type}`, job.id);
    if (job.admittedFor) await this.redis.sRem(`${this.USER_INDEX_PREFIX}${job.admittedFor}`, job.id);
  }

  private async persistNewJob(
    payload: JobPayload,
    maxRetries: number,
    admittedFor?: string,
    idemKey?: string,
  ): Promise<Job> {
    let jobId = crypto.randomUUID();
    let idempotencyClaimed = false;
    const idempotencyStoreKey = idemKey ? `${this.IDEMPOTENCY_PREFIX}${idemKey}` : undefined;

    if (idempotencyStoreKey) {
      // SET NX is the linearisation point for replay suppression.
      idempotencyClaimed = await this.redis.setNxValue(
        idempotencyStoreKey,
        jobId,
        this.idempotencyTtlSeconds,
      );
      if (!idempotencyClaimed) {
        const existing = await this.getIdempotentJob(idemKey!);
        if (existing) {
          this.logger.warn(`Concurrent replay suppressed (key=${idemKey}, job=${existing.id})`);
          return existing;
        }
        // The marker exists but cannot be resolved: fail closed rather than
        // risk a duplicate side effect (matches the redis:down matrix row).
        throw new ServiceUnavailableException('Idempotency store is unavailable');
      }
    }

    const job: Job = {
      id: jobId,
      type: payload.type,
      status: JobStatus.PENDING,
      payload,
      retries: 0,
      maxRetries,
      correlationId: payload.correlationId ?? crypto.randomUUID(),
      createdAt: new Date(),
    };
    if (admittedFor) job.admittedFor = admittedFor;
    if (idemKey) job.idempotencyKey = idemKey;

    const jobKey = `${this.JOB_KEY_PREFIX}${jobId}`;
    const writeResult = await this.redis.set(jobKey, JSON.stringify(job));
    if (writeResult !== 'OK' && idempotencyClaimed && idempotencyStoreKey) {
      // Roll back the claim so the caller can safely retry the same key.
      await this.redis.del(idempotencyStoreKey);
      throw new ServiceUnavailableException('Job queue is unavailable');
    }
    await this.redis.expire(jobKey, 604_800); // 7 days TTL

    // Add to queue
    await this.redis.sAdd(this.QUEUE_KEY, jobId);
    await this.redis.sAdd(`${this.TYPE_INDEX_PREFIX}${job.type}`, jobId);
    if (admittedFor) await this.redis.sAdd(`${this.USER_INDEX_PREFIX}${admittedFor}`, jobId);

    this.logger.log(`Enqueued job ${jobId} of type ${payload.type} (correlationId=${job.correlationId})`);
    return job;
  }

  private async getIdempotentJob(idemKey: string): Promise<Job | null> {
    const jobId = await this.redis.get(`${this.IDEMPOTENCY_PREFIX}${idemKey}`);
    return jobId ? this.getJob(jobId) : null;
  }

  /**
   * Claim the next runnable job. A job stays in the queue set until it reaches
   * a terminal status; the per-job processing lock is the claim. A worker that
   * crashes mid-job never releases its lock, so the job becomes claimable again
   * once the lock expires (at-least-once delivery: handlers must be idempotent).
   *
   * Reads use getOrThrow: a failed read must not be mistaken for a missing job
   * and silently drop it from the queue.
   */
  async dequeue(): Promise<Job | null> {
    const members = await this.redis.sMembers(this.QUEUE_KEY);

    for (const jobId of members) {
      const jobData = await this.redis.getOrThrow(`${this.JOB_KEY_PREFIX}${jobId}`);
      if (!jobData) {
        // Job record expired; drop the stale reference.
        await this.redis.sRem(this.QUEUE_KEY, jobId);
        continue;
      }

      const job = JSON.parse(jobData) as Job;
      if (job.status === JobStatus.SUCCESS || job.status === JobStatus.DEAD_LETTER) {
        // Finished but not yet dequeued (crash between write and removal, or a
        // record written before #348 when removal was a no-op).
        if (job.status === JobStatus.DEAD_LETTER) await this.redis.sAdd(this.DEAD_LETTER_KEY, jobId);
        await this.redis.sRem(this.QUEUE_KEY, jobId);
        await this.removeFromIndexes(job);
        continue;
      }

      const claimed = await this.redis.setNx(
        `${this.PROCESSING_KEY_PREFIX}${jobId}`,
        PROCESSING_LOCK_SECONDS,
      );
      if (!claimed) continue; // in flight on another worker, or Redis unavailable

      job.status = JobStatus.PROCESSING;
      job.startedAt = new Date();
      await this.redis.set(`${this.JOB_KEY_PREFIX}${jobId}`, JSON.stringify(job));
      return job;
    }

    return null;
  }

  async markSuccess(jobId: string, result?: Record<string, any>): Promise<void> {
    const jobKey = `${this.JOB_KEY_PREFIX}${jobId}`;
    const jobData = await this.redis.get(jobKey);

    if (!jobData) {
      this.logger.warn(`Job ${jobId} not found during completion`);
      return;
    }

    const job = JSON.parse(jobData) as Job;
    if (isTerminal(job)) return; // a late worker must not rewrite a finished job
    job.status = JobStatus.SUCCESS;
    job.completedAt = new Date();
    if (result) job.result = result;

    // Unwritten status => keep the claim and queue entry; the lock expires and
    // the job is retried rather than silently lost.
    if (!(await this.persist(jobKey, job))) return;
    await this.redis.sRem(this.QUEUE_KEY, jobId);
    await this.removeFromIndexes(job);
    await this.redis.del(`${this.PROCESSING_KEY_PREFIX}${jobId}`);

    this.logger.log(`Job ${jobId} completed successfully`);
  }

  async markFailure(jobId: string, error: string): Promise<boolean> {
    const jobKey = `${this.JOB_KEY_PREFIX}${jobId}`;
    const jobData = await this.redis.get(jobKey);

    if (!jobData) {
      this.logger.warn(`Job ${jobId} not found during failure handling`);
      return false;
    }

    const job = JSON.parse(jobData) as Job;
    if (isTerminal(job)) return false;
    job.retries++;
    job.lastError = error;
    job.lastErrorAt = new Date();

    if (job.retries >= job.maxRetries) {
      job.status = JobStatus.DEAD_LETTER;
      job.completedAt = new Date();
      if (!(await this.persist(jobKey, job))) return false;
      await this.redis.sAdd(this.DEAD_LETTER_KEY, jobId);
      await this.redis.sRem(this.QUEUE_KEY, jobId);
      await this.removeFromIndexes(job);
      await this.redis.del(`${this.PROCESSING_KEY_PREFIX}${jobId}`);
      this.logger.error(
        `Job ${jobId} moved to dead letter after ${job.retries} retries: ${error}`,
      );
      return false;
    }

    job.status = JobStatus.PENDING;
    if (!(await this.persist(jobKey, job))) return false;
    // Ensure it is queued, then release the claim so any worker can retry it.
    // Retries bypass admission (#391): an admitted job is never shed.
    await this.redis.sAdd(this.QUEUE_KEY, jobId);
    await this.redis.del(`${this.PROCESSING_KEY_PREFIX}${jobId}`);
    this.logger.warn(`Job ${jobId} failed, retrying (${job.retries}/${job.maxRetries}): ${error}`);
    return true;
  }

  /**
   * Re-queue a dead-letter job after the underlying failure has been fixed.
   *
   * Fails closed: the job record is persisted first and the dead-letter set is
   * only updated on success, so a Redis write fault cannot silently lose an
   * exhausted job. Guard: admin-only at the HTTP boundary.
   */
  async recoverDeadLetter(jobId: string, options: RecoverDeadLetterOptions = {}): Promise<Job> {
    const current = await this.getJob(jobId);
    if (!current) throw new NotFoundException(`Job ${jobId} not found`);
    if (current.status !== JobStatus.DEAD_LETTER) {
      throw new BadRequestException(
        `Job ${jobId} is ${current.status}; only dead-letter jobs can be recovered`,
      );
    }

    const token = crypto.randomUUID();
    const acquired = await this.redis.acquireLockOrThrow(
      this.RECOVERY_LOCK_KEY,
      token,
      ADMISSION_LOCK_TTL_MS,
    );
    if (!acquired) throw new ConflictException('Recovery lock contended; retry shortly');

    try {
      // Re-read under the lock: another operator may have recovered it already.
      const job = await this.getJob(jobId);
      if (!job || job.status !== JobStatus.DEAD_LETTER) {
        throw new ConflictException(`Job ${jobId} changed state during recovery`);
      }

      const resetRetries = options.resetRetries !== false;
      const retriesAfter = resetRetries ? 0 : job.retries;
      const maxRetriesAfter =
        options.maxRetries ?? (resetRetries ? job.maxRetries : job.maxRetries + 1);
      if (maxRetriesAfter <= retriesAfter) {
        throw new BadRequestException('maxRetries must allow at least one further attempt');
      }

      const fromStatus = job.status;
      job.status = JobStatus.PENDING;
      job.retries = retriesAfter;
      job.maxRetries = maxRetriesAfter;
      job.completedAt = undefined;
      job.recoveryAttempts = (job.recoveryAttempts ?? 0) + 1;
      job.lastRecoveredAt = new Date();
      job.recoveredFrom = RecoverySource.DEAD_LETTER;

      const jobKey = `${this.JOB_KEY_PREFIX}${jobId}`;
      if (!(await this.persist(jobKey, job))) {
        throw new ServiceUnavailableException('Recovery write failed; job left in dead letter');
      }

      await this.redis.sRem(this.DEAD_LETTER_KEY, jobId);
      await this.redis.sAdd(this.QUEUE_KEY, jobId);
      await this.redis.sAdd(`${this.TYPE_INDEX_PREFIX}${job.type}`, jobId);
      if (job.admittedFor) {
        await this.redis.sAdd(`${this.USER_INDEX_PREFIX}${job.admittedFor}`, jobId);
      }
      await this.redis.del(`${this.PROCESSING_KEY_PREFIX}${jobId}`);

      await this.writeRecoveryAudit({
        jobId,
        jobType: job.type,
        source: RecoverySource.DEAD_LETTER,
        fromStatus,
        toStatus: JobStatus.PENDING,
        retriesBefore: current.retries,
        retriesAfter,
        actor: options.actor,
        correlationId: job.correlationId,
      });

      this.logger.warn(
        `Recovered dead-letter job ${jobId} (retries ${job.retries}/${job.maxRetries})`,
      );
      return job;
    } finally {
      await this.redis.releaseLockOrThrow(this.RECOVERY_LOCK_KEY, token).catch(() => undefined);
    }
  }

  /**
   * Deterministically recover jobs a worker died on: PROCESSING jobs whose
   * processing lock has expired and whose `startedAt` is old enough. A live
   * lock is never broken, so a slow but healthy job is left alone.
   */
  async recoverStuckJobs(options: RecoverStuckOptions = {}): Promise<StuckRecoveryResult> {
    const now = options.now ?? Date.now();
    const olderThanMs = options.olderThanMs ?? JOB_PROCESSING_TIMEOUT_MS;
    const limit = options.limit ?? DEFAULT_RECOVERY_LIMIT;
    const members = await this.redis.sMembers(this.QUEUE_KEY);
    const result: StuckRecoveryResult = { recovered: [], examined: 0, stillLocked: 0 };

    for (const jobId of members) {
      if (result.recovered.length >= limit) break;
      result.examined++;

      const jobKey = `${this.JOB_KEY_PREFIX}${jobId}`;
      const raw = await this.redis.getOrThrow(jobKey);
      if (!raw) {
        await this.redis.sRem(this.QUEUE_KEY, jobId); // expired record: drop stale ref
        continue;
      }
      const job = JSON.parse(raw) as Job;
      if (job.status !== JobStatus.PROCESSING) continue;

      const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : now;
      const lockKey = `${this.PROCESSING_KEY_PREFIX}${jobId}`;
      const lock = await this.redis.get(lockKey);
      if (lock !== null || now - startedAt < olderThanMs) {
        result.stillLocked++;
        continue;
      }

      // Take the claim ourselves before mutating. Without this, a worker could
      // claim the job between the check above and the delete below, and two
      // workers would then run it. setNx stores '1' (the value dequeue uses).
      if (!(await this.redis.setNx(lockKey, PROCESSING_LOCK_SECONDS))) {
        result.stillLocked++;
        continue;
      }

      const fromStatus = job.status;
      job.status = JobStatus.PENDING;
      job.startedAt = undefined;
      job.recoveryAttempts = (job.recoveryAttempts ?? 0) + 1;
      job.lastRecoveredAt = new Date();
      job.recoveredFrom = RecoverySource.STUCK;

      if (!(await this.persist(jobKey, job))) {
        // Claim stays until its TTL; the job is PENDING but not claimable yet.
        // This is safe: better a delayed job than a double execution.
        continue;
      }
      await this.redis.releaseLockOrThrow(lockKey, '1').catch(() => undefined);
      await this.redis.sAdd(this.QUEUE_KEY, jobId);
      await this.writeRecoveryAudit({
        jobId,
        jobType: job.type,
        source: RecoverySource.STUCK,
        fromStatus,
        toStatus: JobStatus.PENDING,
        retriesBefore: job.retries,
        retriesAfter: job.retries,
        actor: options.actor,
        correlationId: job.correlationId,
      });
      result.recovered.push(jobId);
    }

    return result;
  }

  /** Newest-first, best-effort audit of operator/automatic recovery actions. */
  async getRecoveryAudit(limit = DEFAULT_RECOVERY_LIMIT): Promise<JobRecoveryAuditEntry[]> {
    const entries = await this.redis.lrange(this.RECOVERY_AUDIT_KEY, 0, Math.max(0, limit - 1));
    return entries.map((entry) => JSON.parse(entry) as JobRecoveryAuditEntry);
  }

  private async writeRecoveryAudit(
    entry: Omit<JobRecoveryAuditEntry, 'id' | 'recoveredAt'>,
  ): Promise<void> {
    const record: JobRecoveryAuditEntry = {
      ...entry,
      id: crypto.randomUUID(),
      recoveredAt: new Date().toISOString(),
    };
    // lpush/lrange are degrade-only in RedisService: audit is best-effort and
    // never blocks a recovery.
    await this.redis.lpush(this.RECOVERY_AUDIT_KEY, JSON.stringify(record));
  }

  private async persist(jobKey: string, job: Job): Promise<boolean> {
    return (await this.redis.set(jobKey, JSON.stringify(job))) === 'OK';
  }

  async getJob(jobId: string): Promise<Job | null> {
    const jobKey = `${this.JOB_KEY_PREFIX}${jobId}`;
    const jobData = await this.redis.get(jobKey);
    return jobData ? JSON.parse(jobData) : null;
  }

  async getDeadLetterJobs(limit = 100): Promise<Job[]> {
    const members = await this.redis.sMembers(this.DEAD_LETTER_KEY);
    const deadLetterJobs: Job[] = [];

    for (const jobId of members.slice(0, limit)) {
      const job = await this.getJob(jobId);
      if (job && job.status === JobStatus.DEAD_LETTER) {
        deadLetterJobs.push(job);
      }
    }

    return deadLetterJobs;
  }

  async getQueueSize(): Promise<number> {
    const members = await this.redis.sMembers(this.QUEUE_KEY);
    return members.length;
  }
}
