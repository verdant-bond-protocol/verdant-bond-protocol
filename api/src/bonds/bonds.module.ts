import { Module } from '@nestjs/common';
import { BondsController } from './bonds.controller';
import { BondsService } from './bonds.service';
import { BondReconciliationService } from './bond-reconciliation.service';
import { OracleModule } from '../oracle/oracle.module';
import { HolderIndexService } from './holder-index.service';

@Module({
  imports: [OracleModule, ComplianceModule],
  controllers: [BondsController],
  providers: [BondsService, HolderIndexService],
  exports: [BondsService, HolderIndexService],
})
export class BondsModule {}
