import { Injectable, Logger } from '@nestjs/common';
import { JobQueueService } from './job-queue.service';
import { JobType, JOB_PROCESSING_TIMEOUT_MS } from '../interfaces/job.interface';
import { TelemetryService } from '../../common/services/telemetry.service';

export interface JobHandler {
  handle(payload: any): Promise<Record<string, any>>;
}

@Injectable()
export class WorkerService {
  private readonly logger = new Logger(WorkerService.name);
  private readonly handlers = new Map<JobType, JobHandler>();
  private isProcessing = false;

  constructor(
    private readonly jobQueue: JobQueueService,
    private readonly telemetry: TelemetryService,
  ) {}

  registerHandler(jobType: JobType, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
    this.logger.log(`Registered handler for job type: ${jobType}`);
  }

  async processNextJob(): Promise<boolean> {
    if (this.isProcessing) {
      return false;
    }

    this.isProcessing = true;
    try {
      const job = await this.jobQueue.dequeue();
      if (!job) {
        return false;
      }

      const startTime = Date.now();
      const handler = this.handlers.get(job.type);

      if (!handler) {
        this.logger.error(`No handler registered for job type: ${job.type}`);
        await this.jobQueue.markFailure(job.id, `No handler for type ${job.type}`);
        return true;
      }

      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Job processing timeout')), JOB_PROCESSING_TIMEOUT_MS),
        );

        const result = await Promise.race([handler.handle(job.payload.data), timeoutPromise]);
        await this.jobQueue.markSuccess(job.id, result as Record<string, any>);

        this.telemetry.emit({
          operation: `job:${job.type}`,
          actorType: 'system',
          result: 'success',
          durationMs: Date.now() - startTime,
          correlationId: job.payload.correlationId || job.id,
          userId: job.payload.userId,
        });

        return true;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const shouldRetry = await this.jobQueue.markFailure(job.id, errorMsg);

        this.telemetry.emit({
          operation: `job:${job.type}`,
          actorType: 'system',
          result: shouldRetry ? 'failure' : 'failure',
          durationMs: Date.now() - startTime,
          correlationId: job.payload.correlationId || job.id,
          userId: job.payload.userId,
          error: errorMsg,
          errorCode: shouldRetry ? '500' : 'DEAD_LETTER',
        });

        return true;
      }
    } finally {
      this.isProcessing = false;
    }
  }

  async startProcessing(intervalMs = 5000): Promise<void> {
    this.logger.log(`Starting worker with ${intervalMs}ms interval`);

    const process = async () => {
      try {
        const processed = await this.processNextJob();
        if (!processed) {
          // No job available, wait before next check
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        setImmediate(process);
      } catch (error) {
        this.logger.error(`Worker error: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        setImmediate(process);
      }
    };

    process();
  }
}
