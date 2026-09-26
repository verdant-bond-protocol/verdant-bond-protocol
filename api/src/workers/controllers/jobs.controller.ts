import { Controller, Post, Get, Param, Body, UseGuards } from '@nestjs/common';
import { JobQueueService } from '../services/job-queue.service';
import { JobPayload, Job } from '../interfaces/job.interface';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

@Controller('api/v1/jobs')
export class JobsController {
  constructor(private readonly jobQueue: JobQueueService) {}

  @Post('enqueue')
  @UseGuards(JwtAuthGuard)
  async enqueueJob(@Body() payload: JobPayload): Promise<Job> {
    return this.jobQueue.enqueue(payload);
  }

  @Get(':jobId')
  @UseGuards(JwtAuthGuard)
  async getJob(@Param('jobId') jobId: string): Promise<Job | null> {
    return this.jobQueue.getJob(jobId);
  }

  @Get('queue/status')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getQueueStatus(): Promise<{ size: number }> {
    const size = await this.jobQueue.getQueueSize();
    return { size };
  }

  @Get('dead-letter/list')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getDeadLetterJobs(): Promise<Job[]> {
    return this.jobQueue.getDeadLetterJobs();
  }
}
