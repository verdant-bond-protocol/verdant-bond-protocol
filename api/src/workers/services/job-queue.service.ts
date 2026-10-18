import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/services/redis.service';
import {
  Job,
  JobPayload,
  JobStatus,
  JobType,
  DEFAULT_MAX_RETRIES,
} from '../interfaces/job.interface';
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

  private readonly limits: QueueLimits;

  constructor(private readonly redis: RedisService) {
    this.limits = resolveQueueLimits();
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
    if (!this.limits.enabled) return this.persistNewJob(payload, maxRetries);

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

      return await this.persistNewJob(payload, maxRetries, userId);
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

  private async persistNewJob(payload: JobPayload, maxRetries: number, admittedFor?: string): Promise<Job> {
    const jobId = crypto.randomUUID();
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

    const jobKey = `${this.JOB_KEY_PREFIX}${jobId}`;
    await this.redis.set(jobKey, JSON.stringify(job));
    await this.redis.expire(jobKey, 604_800); // 7 days TTL

    // Add to queue
    await this.redis.sAdd(this.QUEUE_KEY, jobId);
    await this.redis.sAdd(`${this.TYPE_INDEX_PREFIX}${job.type}`, jobId);
    if (admittedFor) await this.redis.sAdd(`${this.USER_INDEX_PREFIX}${admittedFor}`, jobId);

    this.logger.log(`Enqueued job ${jobId} of type ${payload.type} (correlationId=${job.correlationId})`);
    return job;
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
