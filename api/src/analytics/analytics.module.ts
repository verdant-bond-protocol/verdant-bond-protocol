import { Module } from '@nestjs/common';
import { PrivacyPreservingAnalyticsService } from './privacy-preserving-analytics.service';

@Module({
  providers: [PrivacyPreservingAnalyticsService],
  exports: [PrivacyPreservingAnalyticsService],
})
export class AnalyticsModule {}
