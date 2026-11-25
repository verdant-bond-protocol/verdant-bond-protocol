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
  NotFoundException,
  Param,
  Optional,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import {
  GovernanceReceiptEnvelope,
  GovernanceReceiptService,
  GovernanceReceiptVerification,
  GOVERNANCE_ACTOR_ROLE,
} from '../services/governance-receipt.service';
import { SignedAuditReceipt } from '../../audit/audit.receipt';
import { ComplianceRulesEngine } from '../services/compliance-rules.engine';
import { ComplianceAttestationService } from '../services/compliance-attestation.service';
import { SanctionsService } from '../services/sanctions.service';
import { ComplianceSnapshotService } from '../services/compliance-snapshot.service';
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
import { InvestorEligibilityCacheService } from '../../auth/investor-eligibility-cache.service';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';

import { KycCommitmentService, OnChainKycCommitment, RegulatorDisclosureRequest, RegulatorDisclosurePackage, EligibilityTier } from '../services/kyc-commitment.service';
import {
  InvestorRejectionExplanationService,
  InvestorRejectionExplanationDto,
} from '../services/investor-rejection-explanation.service';

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
    private readonly snapshots: ComplianceSnapshotService,
    private readonly kycCommitmentService: KycCommitmentService,
    @Optional() private readonly explanationService?: InvestorRejectionExplanationService,
    @Optional() private readonly eligibilityCache?: InvestorEligibilityCacheService,
    @Optional() private readonly governanceReceipts?: GovernanceReceiptService,
  ) {}

  /**
   * Runs a compliance/governance mutation and, when the receipt service is
   * wired (always, in the application module), attaches a signed receipt
   * (#632). The response shape is additive: the original fields are kept and
   * `signedReceipt` is added alongside them.
   */
  private async withReceipt<T extends object>(
    args: {
      action: Parameters<GovernanceReceiptService['execute']>[0]['action'];
      entityId: string;
      req: any;
      idempotencyKey?: string;
      request: unknown;
      reason?: string;
      before?: Record<string, unknown> | null;
      summarize: (result: T) => Record<string, unknown>;
    },
    execute: () => Promise<T> | T,
  ): Promise<T & { signedReceipt?: GovernanceReceiptEnvelope }> {
    if (!this.governanceReceipts) {
      return execute();
    }
    const user = args.req?.user as AuthenticatedUser | undefined;
    // AdminGuard has already established that the caller is the protocol admin.
    const roles = [GOVERNANCE_ACTOR_ROLE, ...((user as any)?.roles ?? [])];
    const { result, signedReceipt } = await this.governanceReceipts.execute<T>({
      action: args.action,
      entityId: args.entityId,
      actor: user?.walletAddress ?? '',
      actorRoles: roles,
      idempotencyKey: args.idempotencyKey,
      request: args.request,
      reason: args.reason,
      before: args.before,
      execute,
      summarize: args.summarize,
    });
    return { ...result, signedReceipt };
  }

  /** Public: the SPKI PEM key that signs governance receipts, for offline verifiers. */
  @Get('receipts/public-key')
  getReceiptPublicKey(): { algorithm: 'Ed25519'; publicKey: string } {
    if (!this.governanceReceipts) throw new NotFoundException('Governance receipts are not enabled');
    return { algorithm: 'Ed25519', publicKey: this.governanceReceipts.publicKey };
  }

  /** Admin/auditor: verify a governance receipt against the audit chain. */
  @Post('receipts/verify')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.OK)
  verifyReceipt(@Body() body: { receipt: SignedAuditReceipt }): GovernanceReceiptVerification {
    if (!this.governanceReceipts) throw new NotFoundException('Governance receipts are not enabled');
    if (!body?.receipt || typeof body.receipt !== 'object') {
      throw new BadRequestException('receipt is required');
    }
    return this.governanceReceipts.verify(body.receipt);
  }

  @Get('snapshots/:eventId')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getSnapshot(@Param('eventId') eventId: string) {
    const snapshot = await this.snapshots.get(eventId);
    if (!snapshot) throw new NotFoundException('Compliance snapshot not found');
    return { ...snapshot, integrityValid: this.snapshots.verify(snapshot) };
  }

  /**
   * Get canonical versioned ruleset with audit hash for verification.
   */
  @Get('ruleset')
  getRuleset(@Query('version') version?: string): VersionedRuleset {
    return this.rulesEngine.getRuleset(version);
  }

  /**
   * Evaluate investor eligibility without constructing or submitting a transaction.
   * Utilizes investor eligibility cache with automatic invalidation on status changes.
   */
  @Post('evaluate')
  @HttpCode(HttpStatus.OK)
  async evaluate(@Body() dto: EvaluateEligibilityDto): Promise<EligibilityDecision> {
    const compute = async () => {
      const kycRecord = await this.kycStore.get(dto.investorAddress);
      const decision = this.rulesEngine.evaluateEligibility({
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
      return {
        decision,
        kycStatus: kycRecord?.status ?? KycStatus.PENDING,
      };
    };

    if (this.eligibilityCache) {
      // The cache stores and returns the decision `compute` produced; its own
      // interface is a structural subset, so narrow back to the full type.
      return (await this.eligibilityCache.getOrCompute(
        dto.investorAddress,
        String(dto.bondId),
        compute,
      )) as unknown as EligibilityDecision;
    }
    return (await compute()).decision;
  }

  /**
   * Admin endpoint: retrieve audit log of eligibility cache invalidations.
   */
  @Get('eligibility/invalidations')
  @UseGuards(JwtAuthGuard, AdminGuard)
  getEligibilityInvalidations(@Query('investor') investor?: string) {
    if (!this.eligibilityCache) return [];
    return this.eligibilityCache.listInvalidations(investor);
  }

  /**
   * Admin endpoint: flush all entries in the investor eligibility cache.
   */
  @Post('eligibility/flush')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.OK)
  flushEligibilityCache(@Req() req: any, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.withReceipt<{ flushed: number }>(
      {
        action: 'compliance.eligibility.flush',
        entityId: 'all',
        req,
        idempotencyKey,
        request: {},
        summarize: (r) => ({ flushed: r.flushed }),
      },
      () => {
        if (!this.eligibilityCache) return { flushed: 0 };
        const user = req.user as AuthenticatedUser;
        const dropped = this.eligibilityCache.flushAll({
          isAdmin: !!(user as AuthenticatedUser & { isAdmin?: boolean })?.isAdmin,
          address: user?.walletAddress || 'admin',
        });
        return { flushed: dropped };
      },
    );
  }

  /**
   * Admin endpoint: invalidate eligibility cache for a specific investor.
   */
  @Post('eligibility/invalidate/:address')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.OK)
  invalidateInvestorEligibility(
    @Param('address') address: string,
    @Body() body: { reason?: string },
    @Req() req?: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const reason = body?.reason ?? 'admin:manual_invalidation';
    return this.withReceipt<{ address: string; dropped: number }>(
      {
        action: 'compliance.eligibility.invalidate',
        entityId: address,
        req,
        idempotencyKey,
        request: { address, reason },
        reason,
        summarize: (r) => ({ address: r.address, dropped: r.dropped }),
      },
      () => {
        if (!this.eligibilityCache) return { address, dropped: 0 };
        const dropped = this.eligibilityCache.invalidateInvestor(address, reason);
        return { address, dropped };
      },
    );
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
    @Req() req?: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SanctionsStatus & { signedReceipt?: GovernanceReceiptEnvelope }> {
    const before = this.sanctionsService.getStatus();
    // The receipt binds to a digest of the submitted lists, not the lists themselves.
    const listDigest = createHash('sha256')
      .update(JSON.stringify({ a: body?.additionalAddresses ?? [], c: body?.additionalCountries ?? [] }))
      .digest('hex');
    return this.withReceipt<SanctionsStatus>(
      {
        action: 'compliance.sanctions.refresh',
        entityId: 'sanctions-list',
        req,
        idempotencyKey,
        request: body ?? {},
        before: { entryCount: before.entryCount, lastRefreshedAt: before.lastRefreshedAt },
        summarize: (s) => ({
          entryCount: s.entryCount,
          lastRefreshedAt: s.lastRefreshedAt,
          addedAddresses: body?.additionalAddresses?.length ?? 0,
          addedCountries: body?.additionalCountries?.length ?? 0,
          listDigest,
        }),
      },
      () => this.sanctionsService.refreshSanctionsList(body),
    );
  }

  /**
   * Governance endpoint to update jurisdiction rules without a contract redeploy.
   */
  @Post('ruleset/update')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.OK)
  async updateJurisdictionRule(
    @Body() body: { jurisdiction: string; updates: Partial<import('../interfaces/compliance.interface').JurisdictionRule> },
    @Req() req: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<VersionedRuleset & { signedReceipt?: GovernanceReceiptEnvelope }> {
    const user = req.user?.walletAddress || 'GOVERNANCE';
    const previous = this.rulesEngine.getRuleset();
    return this.withReceipt<VersionedRuleset>(
      {
        action: 'governance.ruleset.update',
        entityId: String(body?.jurisdiction ?? '').toUpperCase(),
        req,
        idempotencyKey,
        request: body,
        before: { version: previous.version, auditHash: previous.auditHash },
        summarize: (r) => ({ version: r.version, auditHash: r.auditHash, jurisdiction: String(body.jurisdiction).toUpperCase() }),
      },
      () => this.rulesEngine.updateJurisdictionRule(body.jurisdiction, body.updates, user),
    );
  }

  /**
   * Evaluate compliance eligibility for secondary market transfers.
   */
  @Post('evaluate-transfer')
  @HttpCode(HttpStatus.OK)
  async evaluateTransfer(
    @Body() dto: import('../interfaces/compliance.interface').TransferEligibilityContext,
  ): Promise<EligibilityDecision> {
    const toKycRecord = await this.kycStore.get(dto.toAddress);
    const fromKycRecord = await this.kycStore.get(dto.fromAddress);
    return this.rulesEngine.evaluateTransferEligibility({
      ...dto,
      toKycRecord: toKycRecord ? { status: toKycRecord.status, expiresAt: toKycRecord.expiresAt } : undefined,
      fromKycRecord: fromKycRecord ? { status: fromKycRecord.status, expiresAt: fromKycRecord.expiresAt } : undefined,
    });
  }

  /**
   * Evaluate existing position holders after a rule change, enforcing forced-sale grace period handling.
   */
  @Post('evaluate-post-rule-change')
  @HttpCode(HttpStatus.OK)
  async evaluatePostRuleChange(
    @Body() body: {
      holderAddress: string;
      jurisdiction: string;
      bondId: number;
      tranche: TrancheType;
      holdingAmount: string;
      holdingAcquiredTimestamp: number;
      ruleChangedTimestamp?: number;
      gracePeriodDays?: number;
    },
  ): Promise<import('../interfaces/compliance.interface').PostRuleChangeComplianceCheck> {
    const kycRecord = await this.kycStore.get(body.holderAddress);
    return this.rulesEngine.evaluatePostRuleChangeCompliance({
      ...body,
      kycRecord: kycRecord ? { status: kycRecord.status, expiresAt: kycRecord.expiresAt } : undefined,
    });
  }

  /**
   * Generate an on-chain KYC commitment hash and eligibility tier without exposing PII.
   */
  @Post('kyc/commitment')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async generateCommitment(
    @Body() body: { investorAddress: string; jurisdiction: string; tranche?: string },
  ): Promise<OnChainKycCommitment> {
    const kycRecord = await this.kycStore.get(body.investorAddress);
    return this.kycCommitmentService.generateOnChainCommitment({
      investorAddress: body.investorAddress,
      kycStatus: kycRecord?.status ?? KycStatus.NONE,
      jurisdiction: body.jurisdiction,
      expiresAt: kycRecord?.expiresAt,
      tranche: body.tranche,
    });
  }

  /**
   * Documented, access-controlled selective disclosure endpoint for authorized regulators.
   */
  @Post('kyc/selective-disclosure')
  @HttpCode(HttpStatus.OK)
  async discloseToRegulator(
    @Body() body: { request: RegulatorDisclosureRequest; accessReason?: string },
  ): Promise<RegulatorDisclosurePackage> {
    return this.kycCommitmentService.generateRegulatorDisclosurePackage(body.request, body.accessReason);
  }

  /**
   * Explain eligibility rejection with actionable investor guidance.
   */
  @Post('explain-eligibility-rejection')
  @HttpCode(HttpStatus.OK)
  async explainEligibilityRejection(
    @Body() dto: EvaluateEligibilityDto,
  ): Promise<InvestorRejectionExplanationDto> {
    const kycRecord = await this.kycStore.get(dto.investorAddress);
    const decision = this.rulesEngine.evaluateEligibility({
      investorAddress: dto.investorAddress,
      bondId: dto.bondId,
      tranche: dto.tranche ?? TrancheType.STANDARD,
      jurisdiction: dto.jurisdiction ?? 'US',
      purchaseAmount: dto.purchaseAmount,
      kycRecord: kycRecord
        ? { status: kycRecord.status, expiresAt: kycRecord.expiresAt }
        : undefined,
    });

    if (!this.explanationService) {
      throw new NotFoundException('Explanation service not available');
    }

    return this.explanationService.explainEligibilityRejection(
      {
        investorAddress: dto.investorAddress,
        bondId: dto.bondId,
        tranche: dto.tranche ?? TrancheType.STANDARD,
        jurisdiction: dto.jurisdiction ?? 'US',
        purchaseAmount: dto.purchaseAmount,
      },
      decision,
    );
  }

  /**
   * Explain secondary transfer rejection with actionable investor guidance.
   */
  @Post('explain-transfer-rejection')
  @HttpCode(HttpStatus.OK)
  async explainTransferRejection(
    @Body() dto: import('../interfaces/compliance.interface').TransferEligibilityContext,
  ): Promise<InvestorRejectionExplanationDto> {
    const toKycRecord = await this.kycStore.get(dto.toAddress);
    const fromKycRecord = await this.kycStore.get(dto.fromAddress);
    const decision = this.rulesEngine.evaluateTransferEligibility({
      ...dto,
      toKycRecord: toKycRecord ? { status: toKycRecord.status, expiresAt: toKycRecord.expiresAt } : undefined,
      fromKycRecord: fromKycRecord ? { status: fromKycRecord.status, expiresAt: fromKycRecord.expiresAt } : undefined,
    });

    if (!this.explanationService) {
      throw new NotFoundException('Explanation service not available');
    }

    return this.explanationService.explainTransferRejection(
      dto,
      decision.reason || decision.code || 'NON_COMPLIANT',
    );
  }

  /**
   * Retrieve rejection explanation by audit ID.
   */
  @Get('rejections/:auditId')
  @UseGuards(JwtAuthGuard)
  async getRejectionExplanation(
    @Param('auditId') auditId: string,
    @Req() req: any,
  ): Promise<InvestorRejectionExplanationDto> {
    if (!this.explanationService) {
      throw new NotFoundException('Explanation service not available');
    }
    return this.explanationService.getExplanation(auditId, req.user);
  }
}


