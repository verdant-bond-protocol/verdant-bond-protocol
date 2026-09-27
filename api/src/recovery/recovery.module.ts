import { Module } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { RecoveryController } from './recovery.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [RecoveryController],
  providers: [RecoveryService],
  exports: [RecoveryService],
})
export class RecoveryModule {}
