import { Module, Global } from '@nestjs/common';
import { ComplianceRulesEngine } from './services/compliance-rules.engine';
import { ComplianceAttestationService } from './services/compliance-attestation.service';
import { SanctionsService } from './services/sanctions.service';
import { ComplianceController } from './controllers/compliance.controller';
import { ComplianceSnapshotService } from './services/compliance-snapshot.service';
import { KycCommitmentService } from './services/kyc-commitment.service';

@Global()
@Module({
  controllers: [ComplianceController],
  providers: [
    ComplianceRulesEngine,
    ComplianceAttestationService,
    SanctionsService,
    ComplianceSnapshotService,
    KycCommitmentService,
  ],
  exports: [
    ComplianceRulesEngine,
    ComplianceAttestationService,
    SanctionsService,
    ComplianceSnapshotService,
    KycCommitmentService,
  ],
})
export class ComplianceModule {}

