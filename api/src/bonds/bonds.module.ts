import { Module } from '@nestjs/common';
import { BondsController } from './bonds.controller';
import { BondsService } from './bonds.service';
import { BondReconciliationService } from './bond-reconciliation.service';
import { OracleModule } from '../oracle/oracle.module';

@Module({
  imports: [OracleModule],
  controllers: [BondsController],
  providers: [BondsService, BondReconciliationService],
  exports: [BondsService, BondReconciliationService],
})
export class BondsModule {}
