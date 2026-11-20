import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { AuditService } from './audit.service';
import { AuditReceiptService } from './audit-receipt.service';
import { AuditController } from './controllers/audit.controller';

@Module({
  imports: [CommonModule],
  controllers: [AuditController],
  providers: [AuditService, AuditReceiptService],
  exports: [AuditService, AuditReceiptService],
})
export class AuditModule {}
