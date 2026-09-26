import { Module, Global } from '@nestjs/common';
import { ComplianceRulesEngine } from './services/compliance-rules.engine';
import { ComplianceAttestationService } from './services/compliance-attestation.service';
import { SanctionsService } from './services/sanctions.service';
import { ComplianceController } from './controllers/compliance.controller';

@Global()
@Module({
  controllers: [ComplianceController],
  providers: [ComplianceRulesEngine, ComplianceAttestationService, SanctionsService],
  exports: [ComplianceRulesEngine, ComplianceAttestationService, SanctionsService],
})
export class ComplianceModule {}
