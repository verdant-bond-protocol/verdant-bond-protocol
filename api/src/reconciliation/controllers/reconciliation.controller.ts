import { Controller, Post, Get, UseGuards, Body } from '@nestjs/common';
import { ReconciliationService } from '../services/reconciliation.service';
import { DomainInvariantsService } from '../services/domain-invariants.service';
import { ReconciliationReport } from '../interfaces/reconciliation.interface';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { JobQueueService } from '../../workers/services/job-queue.service';
import { JobPayload, JobType } from '../../workers/interfaces/job.interface';
import { Job } from '../../workers/interfaces/job.interface';

@Controller('api/v1/reconciliation')
@UseGuards(JwtAuthGuard, AdminGuard)
export class ReconciliationController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly domainInvariants: DomainInvariantsService,
    private readonly jobQueue: JobQueueService,
  ) {}

  @Post('dry-run')
  async runDryRun(): Promise<ReconciliationReport> {
    return this.reconciliation.runDryRun();
  }

  @Get('validate-restore')
  async validateRestore(): Promise<ReconciliationReport> {
    return this.domainInvariants.validateDomainInvariants();
  }

  @Post('enqueue-job')
  async enqueueReconciliationJob(@Body() body: { dryRun?: boolean }): Promise<Job> {
    const payload: JobPayload = {
      type: JobType.RECONCILIATION,
      data: { dryRun: body.dryRun !== false },
    };
    return this.jobQueue.enqueue(payload, 2);
  }

  @Get('status')
  async getStatus(): Promise<{ invariantCount: number }> {
    return {
      invariantCount: this.reconciliation.getInvariantCount(),
    };
  }
}
