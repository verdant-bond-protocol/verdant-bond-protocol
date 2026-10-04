import { Module } from '@nestjs/common';
import { BondsController } from './bonds.controller';
import { BondsService } from './bonds.service';
import { BondReconciliationService } from './bond-reconciliation.service';
import { OracleModule } from '../oracle/oracle.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { HolderIndexService } from './holder-index.service';
import { CouponBacktestService } from './coupon-backtest.service';

@Module({
  imports: [OracleModule, ComplianceModule],
  controllers: [BondsController],
  providers: [BondsService, HolderIndexService, CouponBacktestService],
  exports: [BondsService, HolderIndexService, CouponBacktestService],
})
export class BondsModule {}

