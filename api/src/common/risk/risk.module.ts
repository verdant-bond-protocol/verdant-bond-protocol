import { Global, Module } from '@nestjs/common';
import { RiskGuard } from './risk.guard';
import { RiskService } from './risk.service';

/**
 * Global so that `@UseGuards(RiskGuard)` can be attached to controllers in any
 * feature module while sharing one velocity store (#375).
 */
@Global()
@Module({
  providers: [RiskService, RiskGuard],
  exports: [RiskService, RiskGuard],
})
export class RiskModule {}
