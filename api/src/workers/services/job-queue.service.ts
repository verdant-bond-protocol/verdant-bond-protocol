import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/services/redis.service';
import {
  Job,
  JobPayload,
  JobStatus,
  JobType,
  DEFAULT_MAX_RETRIES,
} from '../interfaces/job.interface';
import * as crypto from 'crypto';

/** Must exceed JOB_PROCESSING_TIMEOUT_MS so a live job is never double-claimed. */
export const PROCESSING_LOCK_SECONDS = 600;

const isTerminal = (job: Job): boolean =>
  job.status === JobStatus.SUCCESS || job.status === JobStatus.DEAD_LETTER;

@Injectable()
export class JobQueueService {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly QUEUE_KEY = 'job:queue';
  private readonly JOB_KEY_PREFIX = 'job:';
  private readonly PROCESSING_KEY_PREFIX = 'job:processing:';
  private readonly DEAD_LETTER_KEY = 'job:dead-letter';

  constructor(private readonly redis: RedisService) {}

  async enqueue(payload: JobPayload, maxRetries = DEFAULT_MAX_RETRIES): Promise<Job> {
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

    const jobKey = `${this.JOB_KEY_PREFIX}${jobId}`;
    await this.redis.set(jobKey, JSON.stringify(job));
    await this.redis.expire(jobKey, 604_800); // 7 days TTL

    // Add to queue
    await this.redis.sAdd(this.QUEUE_KEY, jobId);

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
      await this.redis.del(`${this.PROCESSING_KEY_PREFIX}${jobId}`);
      this.logger.error(
        `Job ${jobId} moved to dead letter after ${job.retries} retries: ${error}`,
      );
      return false;
    }

    job.status = JobStatus.PENDING;
    if (!(await this.persist(jobKey, job))) return false;
    // Ensure it is queued, then release the claim so any worker can retry it.
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
