import { Module } from '@nestjs/common';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';
import { DataRetentionService } from './data-retention.service';
import { OracleModule } from '../oracle/oracle.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { BondsModule } from '../bonds/bonds.module';

@Module({
  imports: [
    OracleModule,
    MarketplaceModule,
    BondsModule,
  ],
  controllers: [OpsController],
  providers: [OpsService, DataRetentionService],
})
export class OpsModule {}
