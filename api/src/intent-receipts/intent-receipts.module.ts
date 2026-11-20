import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { IntentReceiptService } from './intent-receipt.service';
import { IntentReceiptInterceptor } from './intent-receipt.interceptor';
import { IntentReceiptController } from './intent-receipt.controller';

/**
 * Global so IntentGuard (CommonModule) and IntentReceiptInterceptor (applied
 * per-route by @RequireIntent in feature modules) can resolve the service
 * without every feature module importing this one.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [IntentReceiptController],
  providers: [IntentReceiptService, IntentReceiptInterceptor],
  exports: [IntentReceiptService, IntentReceiptInterceptor],
})
export class IntentReceiptsModule {}
