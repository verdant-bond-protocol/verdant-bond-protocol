import { Module } from '@nestjs/common';
import { WebhookVerificationService } from './webhook-verification.service';

@Module({
  providers: [WebhookVerificationService],
  exports: [WebhookVerificationService],
})
export class WebhooksModule {}
