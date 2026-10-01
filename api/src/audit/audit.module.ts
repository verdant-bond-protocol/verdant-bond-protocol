import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuditService } from './audit.service';
import { AuditController } from './controllers/audit.controller';

@Module({
  imports: [CommonModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
