import { Module } from '@nestjs/common';
import { ReconciliationService } from './services/reconciliation.service';
import { DomainInvariantsService } from './services/domain-invariants.service';
import { ReconciliationJobHandler } from './handlers/reconciliation-job.handler';
import { ReconciliationController } from './controllers/reconciliation.controller';
import { PayoutReconciliationController } from './controllers/payout-reconciliation.controller';
import { PayoutReconciliationService } from './services/payout-reconciliation.service';
import { InMemoryOnChainPayoutClient } from './services/in-memory-payout-chain.client';
import { ON_CHAIN_PAYOUT_CLIENT } from './interfaces/payout-reconciliation.interface';
import { WorkersModule } from '../workers/workers.module';

@Module({
  imports: [WorkersModule],
  controllers: [ReconciliationController, PayoutReconciliationController],
  providers: [
    ReconciliationService,
    DomainInvariantsService,
    ReconciliationJobHandler,
    InMemoryOnChainPayoutClient,
    { provide: ON_CHAIN_PAYOUT_CLIENT, useExisting: InMemoryOnChainPayoutClient },
    PayoutReconciliationService,
  ],
  exports: [
    ReconciliationService,
    DomainInvariantsService,
    ReconciliationJobHandler,
    PayoutReconciliationService,
  ],
})
export class ReconciliationModule {}
