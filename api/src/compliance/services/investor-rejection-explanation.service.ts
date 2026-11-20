import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Address } from '@stellar/stellar-sdk';
import {
  EligibilityDecision,
  EligibilityEvaluationContext,
  TransferEligibilityContext,
  TrancheType,
} from '../interfaces/compliance.interface';
import { AuthenticatedUser, KycStatus } from '../../common/interfaces/authenticated-request.interface';
import { RedisService } from '../../common/services/redis.service';

export type InvestorRejectionCategory =
  | 'IDENTITY_AND_KYC'
  | 'REGULATORY_ACCREDITATION'
  | 'JURISDICTIONAL_SANCTIONS'
  | 'INVESTMENT_LIMITS'
  | 'MARKET_AND_LIFECYCLE'
  | 'BALANCE_AND_ESCROW';

export type InvestorActionType =
  | 'ELIGIBILITY_PREFLIGHT'
  | 'ATTESTATION_REQUEST'
  | 'SECONDARY_TRANSFER'
  | 'TRANCHE_ACQUISITION';

export type InvestorRemediationType =
  | 'SELF_SERVICE'
  | 'DOCUMENT_UPLOAD'
  | 'ADJUST_AMOUNT'
  | 'WAIT_COOLDOWN'
  | 'CONTACT_SUPPORT'
  | 'NON_REMEDIABLE';

export type InvestorRejectionCode =
  | 'KYC_REQUIRED'
  | 'KYC_EXPIRED'
  | 'ACCREDITATION_REQUIRED'
  | 'SANCTIONED_ADDRESS'
  | 'SANCTIONED_JURISDICTION'
  | 'TRANCHE_NOT_PERMITTED'
  | 'OFFERING_CAP_EXCEEDED'
  | 'INSUFFICIENT_SUPPLY_OR_BALANCE'
  | 'BOND_MATURED_OR_INACTIVE'
  | 'TRANSFER_LOCKUP_ACTIVE'
  | 'TRANSFER_COUNTERPARTY_RESTRICTED'
  | 'INVALID_AMOUNT'
  | 'GENERIC_COMPLIANCE_REJECTION';

export interface ActionableRemediation {
  remediationType: InvestorRemediationType;
  isRetryable: boolean;
  retryAfterSeconds?: number;
  actionSteps: string[];
  remediationUrl?: string;
  supportContactEmail?: string;
}

export interface SanitizedRejectionContext {
  investorAddress: string;
  bondId: number;
  tranche?: string;
  jurisdiction?: string;
  attemptedAmount?: string;
  maxAllowedAmount?: string;
  counterpartyAddress?: string;
  lockupExpiresAt?: string;
}

export interface InvestorRejectionExplanationDto {
  auditId: string;
  actionType: InvestorActionType;
  code: InvestorRejectionCode;
  category: InvestorRejectionCategory;
  title: string;
  summary: string;
  detailedExplanation: string;
  remediation: ActionableRemediation;
  sanitizedContext: SanitizedRejectionContext;
  rulesetVersion: string;
  evaluatedAt: string;
  retryCount: number;
}

@Injectable()
export class InvestorRejectionExplanationService {
  private readonly logger = new Logger(InvestorRejectionExplanationService.name);

  // In-memory store of explanation records keyed by auditId
  private readonly explanations = new Map<string, InvestorRejectionExplanationDto>();
  // Index for idempotent retry lookups: key is `investorAddress:actionType:code:bondId` -> auditId
  private readonly retryIndex = new Map<string, string>();

  constructor(@Optional() private readonly redis?: RedisService) {}

  private validateAddress(address: string, fieldName = 'address'): void {
    if (!address) {
      throw new BadRequestException(`Missing required ${fieldName}`);
    }
    try {
      Address.fromString(address);
    } catch {
      throw new BadRequestException(`Invalid Stellar ${fieldName}: ${address}`);
    }
  }

  private validateBondId(bondId: number): void {
    if (!bondId || bondId <= 0 || !Number.isInteger(bondId)) {
      throw new BadRequestException(`Bond ID must be a positive integer, received: ${bondId}`);
    }
  }

  private validateAmount(amount?: string): void {
    if (amount !== undefined) {
      try {
        const val = BigInt(amount);
        if (val < 0n) {
          throw new BadRequestException('Amount cannot be negative');
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        throw new BadRequestException(`Invalid numeric amount: ${amount}`);
      }
    }
  }

  /**
   * Builds an investor-facing explanation for a rejected eligibility evaluation or attestation attempt.
   *
   * Paths:
   * - Normal Path: translates internal ruleset decisions into clear, empathetic, actionable investor feedback.
   * - Failure Path: strictly validates address and numeric constraints, throwing BadRequestException.
   * - Retry Path: updates existing rejection record idempotently if the user retries with identical parameters.
   */
  async explainEligibilityRejection(
    context: EligibilityEvaluationContext,
    decision: EligibilityDecision,
    actionType: InvestorActionType = 'ELIGIBILITY_PREFLIGHT',
  ): Promise<InvestorRejectionExplanationDto> {
    this.validateAddress(context.investorAddress, 'investorAddress');
    this.validateBondId(context.bondId);
    this.validateAmount(context.purchaseAmount);

    const now = new Date().toISOString();
    const rulesetVersion = decision.rulesetVersion || '2026.1';
    const jurisdiction = (context.jurisdiction || 'GLOBAL').toUpperCase();
    const tranche = context.tranche || TrancheType.STANDARD;

    let code: InvestorRejectionCode = 'GENERIC_COMPLIANCE_REJECTION';
    let category: InvestorRejectionCategory = 'IDENTITY_AND_KYC';
    let title = 'Eligibility Check Not Passed';
    let summary = 'Your account does not meet the requirements for this bond offering.';
    let detailedExplanation = 'The protocol enforces regulatory eligibility rules for all bond subscriptions.';
    let remediationType: InvestorRemediationType = 'SELF_SERVICE';
    let isRetryable = true;
    const retryAfterSeconds: number | undefined = undefined;
    let actionSteps: string[] = ['Review eligibility requirements and ensure account credentials are up to date.'];
    let remediationUrl: string | undefined = '/compliance/kyc';

    switch (decision.code) {
      case 'KYC_REQUIRED':
        code = 'KYC_REQUIRED';
        category = 'IDENTITY_AND_KYC';
        title = 'Identity Verification Required';
        summary = 'KYC identity verification is required before you can participate in this offering.';
        detailedExplanation =
          'Global financial regulations require all investors to undergo identity verification before purchasing nature-backed bonds.';
        remediationType = 'DOCUMENT_UPLOAD';
        isRetryable = true;
        actionSteps = [
          'Navigate to the KYC Verification Portal.',
          'Submit a government-issued photo ID (passport, national ID, or driver’s license) and proof of address.',
          'Allow 5-10 minutes for automated verification processing.',
          'Retry your subscription once your account status shows VERIFIED.',
        ];
        remediationUrl = '/compliance/kyc';
        break;

      case 'KYC_EXPIRED':
        code = 'KYC_EXPIRED';
        category = 'IDENTITY_AND_KYC';
        title = 'Identity Verification Expired';
        summary = 'Your KYC verification has expired and must be refreshed.';
        detailedExplanation =
          'Regulatory compliance frameworks mandate periodic refreshes of customer due diligence records. Your prior verification period has ended.';
        remediationType = 'DOCUMENT_UPLOAD';
        isRetryable = true;
        actionSteps = [
          'Visit the KYC Verification Portal to submit current identity documentation.',
          'Complete any updated compliance declarations.',
          'Wait for document verification confirmation.',
          'Resubmit your subscription request.',
        ];
        remediationUrl = '/compliance/kyc';
        break;

      case 'ACCREDITATION_REQUIRED':
        code = 'ACCREDITATION_REQUIRED';
        category = 'REGULATORY_ACCREDITATION';
        title = 'Accredited Investor Status Required';
        summary = `The selected tranche (${tranche}) requires verified accredited investor status in ${jurisdiction}.`;
        detailedExplanation =
          'Securities regulations (e.g. SEC Rule 506(c) under Regulation D in the United States) restrict certain tranches exclusively to accredited investors or qualified purchasers.';
        remediationType = 'DOCUMENT_UPLOAD';
        isRetryable = true;
        actionSteps = [
          'Provide accredited investor verification (e.g., CPA letter, attorney letter, or verification via an approved accreditation partner).',
          'Alternatively, select an unrestricted tranche (such as STANDARD) that permits retail or qualified participation in your jurisdiction.',
          'Submit updated accreditation credentials via the Compliance portal.',
        ];
        remediationUrl = '/compliance/accreditation';
        break;

      case 'OFFERING_CAP_EXCEEDED':
        code = 'OFFERING_CAP_EXCEEDED';
        category = 'INVESTMENT_LIMITS';
        title = 'Statutory Retail Offering Cap Exceeded';
        summary = `Your requested amount exceeds the statutory retail investment limit for ${jurisdiction}.`;
        detailedExplanation =
          'To protect retail participants, local securities laws impose maximum annual or offering caps for non-accredited investors. Your order amount exceeds this limit.';
        remediationType = 'ADJUST_AMOUNT';
        isRetryable = true;
        actionSteps = [
          'Reduce your investment amount below the jurisdiction cap.',
          'If you qualify as an accredited or institutional investor, submit an accreditation upgrade to remove retail caps.',
          'Retry the subscription with the adjusted amount.',
        ];
        remediationUrl = '/bonds/marketplace';
        break;

      case 'TRANCHE_NOT_PERMITTED':
        code = 'TRANCHE_NOT_PERMITTED';
        category = 'REGULATORY_ACCREDITATION';
        title = 'Tranche Not Permitted In Your Jurisdiction';
        summary = `Tranche ${tranche} cannot be offered to investors residing in ${jurisdiction}.`;
        detailedExplanation =
          'The bond issuer and regulatory authorities have not authorized this specific tranche structure for public distribution in your jurisdiction.';
        remediationType = 'SELF_SERVICE';
        isRetryable = true;
        actionSteps = [
          'Choose an alternative tranche permitted in your country (e.g. STANDARD).',
          'Consult the bond prospectus for geographic tranche availability.',
        ];
        remediationUrl = '/bonds';
        break;

      case 'SANCTIONED_ADDRESS':
      case 'SANCTIONED_JURISDICTION':
        code = decision.code === 'SANCTIONED_ADDRESS' ? 'SANCTIONED_ADDRESS' : 'SANCTIONED_JURISDICTION';
        category = 'JURISDICTIONAL_SANCTIONS';
        title = 'Compliance Screening Policy Restriction';
        summary = 'This action cannot be completed due to international regulatory compliance restrictions.';
        detailedExplanation =
          'The protocol enforces international sanctions screening (e.g. OFAC SDN and comprehensive embargoes). Actions from restricted wallet addresses or comprehensive embargo regions are prohibited by law.';
        remediationType = 'NON_REMEDIABLE';
        isRetryable = false;
        actionSteps = [
          'If you believe your wallet address has been flagged in error, submit an appeal with supporting documentation to compliance support.',
          'Do not attempt repeated automated requests.',
        ];
        remediationUrl = '/compliance/appeals';
        break;

      default:
        break;
    }

    const sanitizedContext: SanitizedRejectionContext = {
      investorAddress: context.investorAddress,
      bondId: context.bondId,
      tranche: tranche,
      jurisdiction: jurisdiction,
      attemptedAmount: context.purchaseAmount,
    };

    const remediation: ActionableRemediation = {
      remediationType,
      isRetryable,
      retryAfterSeconds,
      actionSteps,
      remediationUrl,
      supportContactEmail: 'compliance@verdantbond.org',
    };

    // Retry Path: Check if an identical rejection exists for this investor and action
    const retryKey = `${context.investorAddress}:${actionType}:${code}:${context.bondId}`;
    const existingAuditId = this.retryIndex.get(retryKey);
    if (existingAuditId && this.explanations.has(existingAuditId)) {
      const existing = this.explanations.get(existingAuditId)!;
      existing.retryCount += 1;
      existing.evaluatedAt = now;
      existing.sanitizedContext = sanitizedContext;
      this.logger.debug(
        `Idempotent rejection retry count incremented for investor ${context.investorAddress} (Audit ID: ${existing.auditId})`,
      );
      await this.persistExplanation(existing);
      return existing;
    }

    const auditId = randomUUID();
    const explanation: InvestorRejectionExplanationDto = {
      auditId,
      actionType,
      code,
      category,
      title,
      summary,
      detailedExplanation,
      remediation,
      sanitizedContext,
      rulesetVersion,
      evaluatedAt: now,
      retryCount: 0,
    };

    this.explanations.set(auditId, explanation);
    this.retryIndex.set(retryKey, auditId);
    await this.persistExplanation(explanation);

    this.logger.log(
      `Generated rejection explanation ${auditId} for investor ${context.investorAddress} on bond ${context.bondId}: ${code}`,
    );

    return explanation;
  }

  /**
   * Builds an investor-facing explanation for a rejected secondary-market transfer.
   */
  async explainTransferRejection(
    context: TransferEligibilityContext,
    failureReasonOrCode: string,
  ): Promise<InvestorRejectionExplanationDto> {
    this.validateAddress(context.fromAddress, 'fromAddress');
    this.validateAddress(context.toAddress, 'toAddress');
    this.validateBondId(context.bondId);
    this.validateAmount(context.amount);

    const now = new Date().toISOString();
    const rulesetVersion = '2026.1';
    let code: InvestorRejectionCode = 'TRANSFER_COUNTERPARTY_RESTRICTED';
    let category: InvestorRejectionCategory = 'IDENTITY_AND_KYC';
    let title = 'Transfer Could Not Be Completed';
    let summary = 'The secondary market transfer was rejected by compliance rules.';
    let detailedExplanation =
      'Transfers of regulated debt tokens require that both sender and recipient meet jurisdiction and accreditation requirements.';
    let remediationType: InvestorRemediationType = 'SELF_SERVICE';
    let isRetryable = true;
    let actionSteps: string[] = [];
    let remediationUrl = '/transfers';

    const upperReason = (failureReasonOrCode || '').toUpperCase();

    if (upperReason.includes('SENDER') && upperReason.includes('SANCTION')) {
      code = 'SANCTIONED_ADDRESS';
      category = 'JURISDICTIONAL_SANCTIONS';
      title = 'Sender Address Compliance Hold';
      summary = 'Your wallet address is restricted from transferring protocol tokens.';
      detailedExplanation =
        'Sender wallet address is flagged under international compliance lists. Token transfers are restricted.';
      remediationType = 'NON_REMEDIABLE';
      isRetryable = false;
      actionSteps = ['Contact protocol compliance support for inquiry.'];
      remediationUrl = '/compliance/support';
    } else if (upperReason.includes('RECIPIENT') && (upperReason.includes('KYC_REQUIRED') || upperReason.includes('MINIMUM_KYC'))) {
      code = 'TRANSFER_COUNTERPARTY_RESTRICTED';
      category = 'IDENTITY_AND_KYC';
      title = 'Recipient Must Complete Verification';
      summary = 'The recipient wallet has not completed required KYC identity verification.';
      detailedExplanation =
        'Regulated green bonds cannot be transferred to unverified anonymous addresses. The recipient must complete KYC verification before receiving tokens.';
      remediationType = 'SELF_SERVICE';
      isRetryable = true;
      actionSteps = [
        'Ask the recipient to log in and complete identity verification via /compliance/kyc.',
        'Once their KYC status is VERIFIED, re-attempt the transfer.',
      ];
      remediationUrl = '/compliance/kyc';
    } else if (upperReason.includes('RECIPIENT') && upperReason.includes('ACCREDIT')) {
      code = 'ACCREDITATION_REQUIRED';
      category = 'REGULATORY_ACCREDITATION';
      title = 'Recipient Not Accredited for Restricted Tranche';
      summary = `The recipient wallet lacks accredited investor credentials required for tranche ${context.tranche}.`;
      detailedExplanation =
        'Restricted bond tranches may only be held by verified accredited investors in the recipient jurisdiction.';
      remediationType = 'DOCUMENT_UPLOAD';
      isRetryable = true;
      actionSteps = [
        'Confirm the recipient has uploaded accredited investor certification.',
        'Alternatively, only transfer unrestricted tranches if permitted.',
      ];
      remediationUrl = '/compliance/accreditation';
    } else if (upperReason.includes('OFFERING_CAP') || upperReason.includes('CAP_EXCEEDED')) {
      code = 'OFFERING_CAP_EXCEEDED';
      category = 'INVESTMENT_LIMITS';
      title = 'Recipient Offering Cap Exceeded';
      summary = 'The transfer would exceed the statutory retail holding limit for the recipient jurisdiction.';
      detailedExplanation =
        'Secondary market transfers cannot push a retail counterparty above their statutory jurisdiction holding cap.';
      remediationType = 'ADJUST_AMOUNT';
      isRetryable = true;
      actionSteps = [
        'Reduce the transfer amount to fit within the recipient’s remaining cap.',
        'Prompt recipient to seek accredited investor status if eligible.',
      ];
      remediationUrl = '/transfers';
    } else if (upperReason.includes('INSUFFICIENT_SUPPLY') || upperReason.includes('BALANCE')) {
      code = 'INSUFFICIENT_SUPPLY_OR_BALANCE';
      category = 'BALANCE_AND_ESCROW';
      title = 'Insufficient Token Balance';
      summary = 'Your wallet does not hold sufficient confirmed balance to complete this transfer.';
      detailedExplanation =
        'The transfer amount requested exceeds your currently available, unencumbered token balance on-chain.';
      remediationType = 'ADJUST_AMOUNT';
      isRetryable = true;
      actionSteps = [
        'Check your confirmed wallet balance.',
        'Adjust the transfer amount to be equal to or less than your held balance.',
      ];
      remediationUrl = '/portfolio';
    } else if (upperReason.includes('MATURED') || upperReason.includes('BONDALREADYMATURED')) {
      code = 'BOND_MATURED_OR_INACTIVE';
      category = 'MARKET_AND_LIFECYCLE';
      title = 'Bond Has Reached Maturity';
      summary = 'Transfers are closed because this bond series has matured.';
      detailedExplanation =
        'Upon reaching bond maturity, secondary transfers are frozen to permit orderly principal and coupon redemption.';
      remediationType = 'NON_REMEDIABLE';
      isRetryable = false;
      actionSteps = [
        'Proceed to the redemption queue to redeem principal and final coupon distributions.',
      ];
      remediationUrl = '/redemption';
    }

    const sanitizedContext: SanitizedRejectionContext = {
      investorAddress: context.fromAddress,
      counterpartyAddress: context.toAddress,
      bondId: context.bondId,
      tranche: context.tranche,
      jurisdiction: context.fromJurisdiction,
      attemptedAmount: context.amount,
    };

    const remediation: ActionableRemediation = {
      remediationType,
      isRetryable,
      actionSteps,
      remediationUrl,
      supportContactEmail: 'support@verdantbond.org',
    };

    const retryKey = `${context.fromAddress}:SECONDARY_TRANSFER:${code}:${context.bondId}`;
    const existingAuditId = this.retryIndex.get(retryKey);
    if (existingAuditId && this.explanations.has(existingAuditId)) {
      const existing = this.explanations.get(existingAuditId)!;
      existing.retryCount += 1;
      existing.evaluatedAt = now;
      existing.sanitizedContext = sanitizedContext;
      await this.persistExplanation(existing);
      return existing;
    }

    const auditId = randomUUID();
    const explanation: InvestorRejectionExplanationDto = {
      auditId,
      actionType: 'SECONDARY_TRANSFER',
      code,
      category,
      title,
      summary,
      detailedExplanation,
      remediation,
      sanitizedContext,
      rulesetVersion,
      evaluatedAt: now,
      retryCount: 0,
    };

    this.explanations.set(auditId, explanation);
    this.retryIndex.set(retryKey, auditId);
    await this.persistExplanation(explanation);

    return explanation;
  }

  /**
   * Authorization Path: Retrieves an existing explanation record.
   * Access is strictly restricted to:
   * 1. The affected investor themselves (matching walletAddress).
   * 2. An authorized administrator or compliance officer (role 'admin' or 'compliance_officer').
   */
  async getExplanation(
    auditId: string,
    requestingUser?: AuthenticatedUser,
  ): Promise<InvestorRejectionExplanationDto> {
    if (!auditId) {
      throw new BadRequestException('Audit ID is required');
    }

    let explanation = this.explanations.get(auditId);
    if (!explanation && this.redis) {
      try {
        const raw = await this.redis.get(`rejection:audit:${auditId}`);
        if (raw) explanation = JSON.parse(raw);
      } catch {}
    }

    if (!explanation) {
      throw new NotFoundException(`Rejection explanation record '${auditId}' not found`);
    }

    if (requestingUser) {
      const isOwner =
        requestingUser.walletAddress &&
        requestingUser.walletAddress.toLowerCase() ===
          explanation.sanitizedContext.investorAddress.toLowerCase();
      const isAdmin =
        requestingUser.roles?.includes('admin') ||
        requestingUser.roles?.includes('compliance_officer') ||
        requestingUser.permissions?.includes('compliance:read');

      if (!isOwner && !isAdmin) {
        throw new ForbiddenException(
          'You are not authorized to view this rejection explanation record',
        );
      }
    }

    return explanation;
  }

  /**
   * Authorization Path: Lists historical rejection records for a specific investor address.
   */
  async listInvestorRejections(
    investorAddress: string,
    requestingUser?: AuthenticatedUser,
  ): Promise<InvestorRejectionExplanationDto[]> {
    this.validateAddress(investorAddress, 'investorAddress');

    if (requestingUser) {
      const isOwner =
        requestingUser.walletAddress &&
        requestingUser.walletAddress.toLowerCase() === investorAddress.toLowerCase();
      const isAdmin =
        requestingUser.roles?.includes('admin') ||
        requestingUser.roles?.includes('compliance_officer');

      if (!isOwner && !isAdmin) {
        throw new ForbiddenException(
          'You are not authorized to list rejection records for another investor',
        );
      }
    }

    return Array.from(this.explanations.values())
      .filter(
        (e) =>
          e.sanitizedContext.investorAddress.toLowerCase() === investorAddress.toLowerCase(),
      )
      .sort((a, b) => new Date(b.evaluatedAt).getTime() - new Date(a.evaluatedAt).getTime());
  }

  private async persistExplanation(dto: InvestorRejectionExplanationDto): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(
          `rejection:audit:${dto.auditId}`,
          JSON.stringify(dto),
          { EX: 86400 * 30 },
        );
      } catch (err) {
        this.logger.warn(`Failed to cache rejection explanation to Redis: ${err}`);
      }
    }
  }
}
