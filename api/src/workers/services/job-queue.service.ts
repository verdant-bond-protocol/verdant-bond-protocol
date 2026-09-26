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

@Injectable()
export class JobQueueService {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly QUEUE_KEY = 'job:queue';
  private readonly JOB_KEY_PREFIX = 'job:';
  private readonly PROCESSING_KEY_PREFIX = 'job:processing:';

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
      createdAt: new Date(),
    };

    const jobKey = `${this.JOB_KEY_PREFIX}${jobId}`;
    await this.redis.set(jobKey, JSON.stringify(job));
    await this.redis.expire(jobKey, 604_800); // 7 days TTL

    // Add to queue
    await this.redis.sAdd(this.QUEUE_KEY, jobId);

    this.logger.log(`Enqueued job ${jobId} of type ${payload.type}`);
    return job;
  }

  async dequeue(): Promise<Job | null> {
    const members = await this.redis.sMembers(this.QUEUE_KEY);
    if (members.length === 0) return null;

    const jobId = members[0];
    const jobKey = `${this.JOB_KEY_PREFIX}${jobId}`;
    const jobData = await this.redis.get(jobKey);

    if (!jobData) {
      // Stale reference, remove from queue
      await this.redis.sAdd(this.QUEUE_KEY, jobId);
      return this.dequeue();
    }

    const job = JSON.parse(jobData) as Job;
    job.status = JobStatus.PROCESSING;
    job.startedAt = new Date();

    // Move to processing set with TTL lock
    const processingKey = `${this.PROCESSING_KEY_PREFIX}${jobId}`;
    const lockToken = crypto.randomUUID();
    await this.redis.set(processingKey, lockToken);
    await this.redis.expire(processingKey, 600); // 10 minute processing timeout

    // Remove from queue
    await this.redis.sAdd(this.QUEUE_KEY, jobId);

    // Update job in Redis
    await this.redis.set(jobKey, JSON.stringify(job));

    return job;
  }

  async markSuccess(jobId: string, result?: Record<string, any>): Promise<void> {
    const jobKey = `${this.JOB_KEY_PREFIX}${jobId}`;
    const jobData = await this.redis.get(jobKey);

    if (!jobData) {
      this.logger.warn(`Job ${jobId} not found during completion`);
      return;
    }

    const job = JSON.parse(jobData) as Job;
    job.status = JobStatus.SUCCESS;
    job.completedAt = new Date();
    if (result) job.result = result;

    await this.redis.set(jobKey, JSON.stringify(job));
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
    job.retries++;
    job.lastError = error;
    job.lastErrorAt = new Date();

    if (job.retries >= job.maxRetries) {
      job.status = JobStatus.DEAD_LETTER;
      job.completedAt = new Date();
      await this.redis.set(jobKey, JSON.stringify(job));
      await this.redis.del(`${this.PROCESSING_KEY_PREFIX}${jobId}`);
      this.logger.error(
        `Job ${jobId} moved to dead letter after ${job.retries} retries: ${error}`,
      );
      return false;
    }

    job.status = JobStatus.PENDING;
    await this.redis.set(jobKey, JSON.stringify(job));
    await this.redis.del(`${this.PROCESSING_KEY_PREFIX}${jobId}`);

    // Re-queue for retry
    await this.redis.sAdd(this.QUEUE_KEY, jobId);
    this.logger.warn(`Job ${jobId} failed, retrying (${job.retries}/${job.maxRetries}): ${error}`);
    return true;
  }

  async getJob(jobId: string): Promise<Job | null> {
    const jobKey = `${this.JOB_KEY_PREFIX}${jobId}`;
    const jobData = await this.redis.get(jobKey);
    return jobData ? JSON.parse(jobData) : null;
  }

  async getDeadLetterJobs(limit = 100): Promise<Job[]> {
    const members = await this.redis.sMembers(this.QUEUE_KEY);
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
