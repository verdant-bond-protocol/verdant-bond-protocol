import { Module } from '@nestjs/common';
import { RedemptionService } from './redemption.service';
import { RedemptionController } from './redemption.controller';
import { BondsModule } from '../bonds/bonds.module';
import { OracleModule } from '../oracle/oracle.module';

@Module({
  imports: [BondsModule, OracleModule],
  providers: [RedemptionService],
  controllers: [RedemptionController],
  exports: [RedemptionService],
})
export class RedemptionModule {}
