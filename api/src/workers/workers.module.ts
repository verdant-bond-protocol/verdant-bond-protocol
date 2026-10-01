import { Module } from '@nestjs/common';
import { JobQueueService } from './services/job-queue.service';
import { WorkerService } from './services/worker.service';
import { JobsController } from './controllers/jobs.controller';

@Module({
  controllers: [JobsController],
  providers: [JobQueueService, WorkerService],
  exports: [JobQueueService, WorkerService],
})
export class WorkersModule {}
