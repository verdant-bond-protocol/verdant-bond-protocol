import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ComplianceRulesEngine } from '../services/compliance-rules.engine';
import { ComplianceAttestationService } from '../services/compliance-attestation.service';
import { SanctionsService } from '../services/sanctions.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-request.interface';
import {
  EligibilityDecision,
  SignedEligibilityAttestation,
  SanctionsStatus,
  TrancheType,
  VersionedRuleset,
} from '../interfaces/compliance.interface';

import { KycStoreService } from '../../common/services/kyc-store.service';

export class RequestAttestationDto {
  bondId: number;
  tranche?: TrancheType;
  jurisdiction?: string;
  purchaseAmount?: string;
}

export class EvaluateEligibilityDto {
  investorAddress: string;
  bondId: number;
  tranche?: TrancheType;
  jurisdiction?: string;
  purchaseAmount?: string;
}

@Controller('api/v1/compliance')
export class ComplianceController {
  constructor(
    private readonly rulesEngine: ComplianceRulesEngine,
    private readonly attestationService: ComplianceAttestationService,
    private readonly sanctionsService: SanctionsService,
    private readonly kycStore: KycStoreService,
  ) {}

  /**
   * Get canonical versioned ruleset with audit hash for verification.
   */
  @Get('ruleset')
  getRuleset(@Query('version') version?: string): VersionedRuleset {
    return this.rulesEngine.getRuleset(version);
  }

  /**
   * Evaluate investor eligibility without constructing or submitting a transaction.
   */
  @Post('evaluate')
  @HttpCode(HttpStatus.OK)
  async evaluate(@Body() dto: EvaluateEligibilityDto): Promise<EligibilityDecision> {
    const kycRecord = await this.kycStore.get(dto.investorAddress);
    return this.rulesEngine.evaluateEligibility({
      investorAddress: dto.investorAddress,
      bondId: dto.bondId,
      tranche: dto.tranche ?? TrancheType.STANDARD,
      jurisdiction: dto.jurisdiction ?? 'US',
      purchaseAmount: dto.purchaseAmount,
      kycRecord: kycRecord
        ? {
            status: kycRecord.status,
            expiresAt: kycRecord.expiresAt,
          }
        : undefined,
    });
  }

  /**
   * Issue a signed eligibility attestation for an authenticated investor.
   * Required for purchasing restricted tranches.
   */
  @Post('attestation')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async issueAttestation(
    @Body() dto: RequestAttestationDto,
    @Req() req: any,
  ): Promise<SignedEligibilityAttestation> {
    const user = req.user as AuthenticatedUser;
    if (!user || !user.walletAddress) {
      throw new ForbiddenException('Authenticated wallet session required');
    }

    return this.attestationService.issueAttestation({
      investorAddress: user.walletAddress,
      bondId: dto.bondId,
      tranche: dto.tranche ?? TrancheType.STANDARD,
      jurisdiction: dto.jurisdiction ?? 'US',
      purchaseAmount: dto.purchaseAmount,
    });
  }

  /**
   * Get active sanctions list status, documented refresh cadence, and staleness alert.
   */
  @Get('sanctions/status')
  getSanctionsStatus(): SanctionsStatus {
    return this.sanctionsService.getStatus();
  }

  /**
   * Admin endpoint to trigger an explicit sanctions list refresh.
   */
  @Post('sanctions/refresh')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.OK)
  async refreshSanctions(
    @Body() body: { additionalAddresses?: string[]; additionalCountries?: string[] },
  ): Promise<SanctionsStatus> {
    return this.sanctionsService.refreshSanctionsList(body);
  }
}
