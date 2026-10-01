import { Module } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { RecoveryController } from './recovery.controller';
import { RollbackVerificationService } from './rollback-verification.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [RecoveryController],
  providers: [RecoveryService, RollbackVerificationService],
  exports: [RecoveryService, RollbackVerificationService],
})
export class RecoveryModule {}
