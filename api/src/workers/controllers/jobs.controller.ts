import { Controller, Post, Get, Param, Body, UseGuards, Req, ForbiddenException } from '@nestjs/common';
import { JobQueueService, BackpressureStatus } from '../services/job-queue.service';
import { JobPayload, Job, JobType } from '../interfaces/job.interface';
import {
  JobRecoveryAuditEntry,
  RecoverDeadLetterOptions,
  RecoverStuckOptions,
  StuckRecoveryResult,
} from '../interfaces/job-recovery.interface';
import {
  DEPENDENCY_FALLBACK_MATRIX,
  DependencyName,
  decideFallback,
  matrixGaps,
} from '../services/dependency-fallback';
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

  /** Admin-only: re-queue one exhausted job after the root cause is fixed. */
  @Post('dead-letter/:jobId/recover')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async recoverDeadLetter(
    @Param('jobId') jobId: string,
    @Body() options: RecoverDeadLetterOptions,
    @Req() req: any,
  ): Promise<Job> {
    const actor: string | undefined = req?.user?.walletAddress ?? req?.user?.sub;
    return this.jobQueue.recoverDeadLetter(jobId, { ...options, actor });
  }

  /** Admin-only: deterministic sweep of interrupted ( PROCESSING ) jobs. */
  @Post('recover/stuck')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async recoverStuck(
    @Body() options: RecoverStuckOptions,
    @Req() req: any,
  ): Promise<StuckRecoveryResult> {
    const actor: string | undefined = req?.user?.walletAddress ?? req?.user?.sub;
    return this.jobQueue.recoverStuckJobs({ ...options, actor });
  }

  @Get('recovery/audit')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getRecoveryAudit(): Promise<JobRecoveryAuditEntry[]> {
    return this.jobQueue.getRecoveryAudit();
  }

  /**
   * Operator-visible degradation matrix. Decisions are pure data so this view
   * can be used by runbooks and by the dependency-fallback tests.
   */
  @Get('recovery/dependency-matrix')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getDependencyMatrix(): Promise<{
    matrix: typeof DEPENDENCY_FALLBACK_MATRIX;
    decisions: ReturnType<typeof decideFallback>[];
    gaps: ReturnType<typeof matrixGaps>;
  }> {
    const decisions = [] as ReturnType<typeof decideFallback>[];
    for (const dependency of Object.keys(DEPENDENCY_FALLBACK_MATRIX) as DependencyName[]) {
      for (const state of ['operational', 'degraded', 'down', 'unknown'] as const) {
        decisions.push(decideFallback(dependency, state));
      }
    }
    return { matrix: DEPENDENCY_FALLBACK_MATRIX, decisions, gaps: matrixGaps() };
  }
}
