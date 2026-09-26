import { Module } from '@nestjs/common';
import { BondsController } from './bonds.controller';
import { BondsService } from './bonds.service';
import { BondReconciliationService } from './bond-reconciliation.service';
import { OracleModule } from '../oracle/oracle.module';
import { ComplianceModule } from '../compliance/compliance.module';

@Module({
  imports: [OracleModule, ComplianceModule],
  controllers: [BondsController],
  providers: [BondsService, BondReconciliationService],
  exports: [BondsService, BondReconciliationService],
})
export class BondsModule {}
