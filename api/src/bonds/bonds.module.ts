import { Module } from '@nestjs/common';
import { BondsController } from './bonds.controller';
import { BondsService } from './bonds.service';
import { BondReconciliationService } from './bond-reconciliation.service';
import { OracleModule } from '../oracle/oracle.module';
import { HolderIndexService } from './holder-index.service';
import { ComplianceModule } from '../compliance/compliance.module';

@Module({
  imports: [OracleModule, ComplianceModule],
  controllers: [BondsController],
  providers: [BondsService, HolderIndexService, BondReconciliationService],
  exports: [BondsService, HolderIndexService, BondReconciliationService],
})
export class BondsModule {}
