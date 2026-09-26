import { Module } from '@nestjs/common';
import { ReconciliationService } from './services/reconciliation.service';
import { ReconciliationJobHandler } from './handlers/reconciliation-job.handler';
import { ReconciliationController } from './controllers/reconciliation.controller';
import { WorkersModule } from '../workers/workers.module';

@Module({
  imports: [WorkersModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, ReconciliationJobHandler],
  exports: [ReconciliationService, ReconciliationJobHandler],
})
export class ReconciliationModule {}
