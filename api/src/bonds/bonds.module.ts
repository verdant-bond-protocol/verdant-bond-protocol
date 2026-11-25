import { Module } from '@nestjs/common';
import { BondsController } from './bonds.controller';
import { BondsService } from './bonds.service';
import { RegulatorExportService } from './regulator-export.service';
import { BondReconciliationService } from './bond-reconciliation.service';
import { OracleModule } from '../oracle/oracle.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { HolderIndexService } from './holder-index.service';
import { StaleIndexDetectionService } from './stale-index-detection.service';
import { MaturedBondArchivalService } from './matured-bond-archival.service';
import { LiabilityReserveAlertService } from './liability-reserve-alert.service';
import { SubscriptionCancellationService } from './subscription-cancellation.service';

@Module({
  imports: [OracleModule, ComplianceModule],
  controllers: [BondsController],
  providers: [
    BondsService,
    RegulatorExportService,
    HolderIndexService,
    BondReconciliationService,
    StaleIndexDetectionService,
    MaturedBondArchivalService,
    LiabilityReserveAlertService,
    SubscriptionCancellationService,
  ],
  exports: [
    BondsService,
    RegulatorExportService,
    HolderIndexService,
    BondReconciliationService,
    StaleIndexDetectionService,
    MaturedBondArchivalService,
    LiabilityReserveAlertService,
    SubscriptionCancellationService,
  ],
})
export class BondsModule {}

