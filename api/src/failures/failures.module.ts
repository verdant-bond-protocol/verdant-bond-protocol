import { Module } from '@nestjs/common';
import { PartialFailureService } from './partial-failure.service';
import { PartialFailureController } from './partial-failure.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [PartialFailureController],
  providers: [PartialFailureService],
  exports: [PartialFailureService],
})
export class FailuresModule {}
