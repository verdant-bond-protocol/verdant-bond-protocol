import { Module } from '@nestjs/common';
import { PartialFailureService } from './partial-failure.service';
import { PartialFailureController } from './partial-failure.controller';
import { PayoutRedemptionFailureInjectionService } from './payout-redemption-failure-injection.service';
import { FailureInjectionController } from './failure-injection.controller';
import { ContractFaultInjectionBootstrap } from './contract-fault-injector';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [PartialFailureController, FailureInjectionController],
  providers: [PartialFailureService, PayoutRedemptionFailureInjectionService, ContractFaultInjectionBootstrap],
  exports: [PartialFailureService, PayoutRedemptionFailureInjectionService],
})
export class FailuresModule {}

