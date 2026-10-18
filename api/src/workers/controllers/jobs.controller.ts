import { Controller, Post, Get, Param, Body, UseGuards, Req, ForbiddenException } from '@nestjs/common';
import { JobQueueService, BackpressureStatus } from '../services/job-queue.service';
import { JobPayload, Job, JobType } from '../interfaces/job.interface';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

/**
 * Job types a non-admin may submit directly (#391). Everything else moves
 * money or rewrites shared state and is enqueued by admin routes only.
 */
export const SELF_SERVICE_JOB_TYPES: ReadonlySet<JobType> = new Set([
  JobType.DATA_EXPORT,
  JobType.PORTFOLIO_REBALANCE,
]);

@Controller('api/v1/jobs')
export class JobsController {
  constructor(private readonly jobQueue: JobQueueService) {}

  /**
   * The submitting identity always comes from the token, never the body, so a
   * caller cannot spend another user's per-user admission budget (#391).
   */
  @Post('enqueue')
  @UseGuards(JwtAuthGuard)
  async enqueueJob(@Body() payload: JobPayload, @Req() req: any): Promise<Job> {
    const caller: string | undefined = req.user?.walletAddress ?? req.user?.sub;
    const adminKey = process.env.STELLAR_PUBLIC_KEY;
    const privileged = Boolean(adminKey && req.user?.walletAddress === adminKey);

    if (!privileged && !SELF_SERVICE_JOB_TYPES.has(payload?.type)) {
      throw new ForbiddenException(`Job type ${payload?.type} may only be enqueued by an admin`);
    }

    return this.jobQueue.enqueue({ ...payload, userId: caller }, undefined, { privileged });
  }

  @Get(':jobId')
  @UseGuards(JwtAuthGuard)
  async getJob(@Param('jobId') jobId: string): Promise<Job | null> {
    return this.jobQueue.getJob(jobId);
  }

  @Get('queue/status')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getQueueStatus(): Promise<{ size: number; backpressure: BackpressureStatus }> {
    const size = await this.jobQueue.getQueueSize();
    const backpressure = await this.jobQueue.getBackpressureStatus();
    return { size, backpressure };
  }

  @Get('dead-letter/list')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getDeadLetterJobs(): Promise<Job[]> {
    return this.jobQueue.getDeadLetterJobs();
  }
}
