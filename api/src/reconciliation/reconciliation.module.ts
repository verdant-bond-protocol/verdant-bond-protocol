import { Module } from '@nestjs/common';
import { ReconciliationService } from './services/reconciliation.service';
import { DomainInvariantsService } from './services/domain-invariants.service';
import { ReconciliationJobHandler } from './handlers/reconciliation-job.handler';
import { ReconciliationController } from './controllers/reconciliation.controller';
import { WorkersModule } from '../workers/workers.module';

@Module({
  imports: [WorkersModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, DomainInvariantsService, ReconciliationJobHandler],
  exports: [ReconciliationService, DomainInvariantsService, ReconciliationJobHandler],
})
export class ReconciliationModule {}
