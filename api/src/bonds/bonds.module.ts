import { Module } from '@nestjs/common';
import { BondsController } from './bonds.controller';
import { BondsService } from './bonds.service';
import { BondReconciliationService } from './bond-reconciliation.service';
import { OracleModule } from '../oracle/oracle.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { HolderIndexService } from './holder-index.service';
import { StaleIndexDetectionService } from './stale-index-detection.service';
import { MaturedBondArchivalService } from './matured-bond-archival.service';

@Module({
  imports: [OracleModule, ComplianceModule],
  controllers: [BondsController],
  providers: [
    BondsService,
    HolderIndexService,
    BondReconciliationService,
    StaleIndexDetectionService,
    MaturedBondArchivalService,
  ],
  exports: [
    BondsService,
    HolderIndexService,
    BondReconciliationService,
    StaleIndexDetectionService,
    MaturedBondArchivalService,
  ],
})
export class BondsModule {}

