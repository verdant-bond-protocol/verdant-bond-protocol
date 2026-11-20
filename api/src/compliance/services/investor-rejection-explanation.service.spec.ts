import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  InvestorRejectionExplanationService,
  InvestorRejectionExplanationDto,
} from './investor-rejection-explanation.service';
import {
  EligibilityDecision,
  EligibilityEvaluationContext,
  TransferEligibilityContext,
  TrancheType,
} from '../interfaces/compliance.interface';
import { AuthenticatedUser, KycStatus } from '../../common/interfaces/authenticated-request.interface';
import { Keypair } from '@stellar/stellar-sdk';

describe('InvestorRejectionExplanationService', () => {
  let service: InvestorRejectionExplanationService;

  const VALID_INVESTOR_1 = Keypair.random().publicKey();
  const VALID_INVESTOR_2 = Keypair.random().publicKey();
  const INVALID_ADDRESS = 'NOT_A_VALID_STELLAR_ADDRESS';

  beforeEach(() => {
    service = new InvestorRejectionExplanationService();
  });

  describe('Normal Path: Eligibility Rejections', () => {
    it('should generate an actionable explanation for KYC_REQUIRED', async () => {
      const context: EligibilityEvaluationContext = {
        investorAddress: VALID_INVESTOR_1,
        bondId: 101,
        jurisdiction: 'US',
        tranche: TrancheType.STANDARD,
      };

      const decision: EligibilityDecision = {
        eligible: false,
        code: 'KYC_REQUIRED',
        reason: 'KYC verification is required before investing in bond 101.',
        rulesetVersion: '2026.1',
        jurisdiction: 'US',
        tranche: TrancheType.STANDARD,
        requiresAttestation: false,
        evaluatedRules: [{ ruleName: 'MINIMUM_KYC_STATUS_CHECK', passed: false }],
      };

      const explanation = await service.explainEligibilityRejection(context, decision);

      expect(explanation.code).toBe('KYC_REQUIRED');
      expect(explanation.category).toBe('IDENTITY_AND_KYC');
      expect(explanation.title).toBe('Identity Verification Required');
      expect(explanation.remediation.remediationType).toBe('DOCUMENT_UPLOAD');
      expect(explanation.remediation.isRetryable).toBe(true);
      expect(explanation.remediation.actionSteps).toContain(
        'Retry your subscription once your account status shows VERIFIED.',
      );
      expect(explanation.remediation.remediationUrl).toBe('/compliance/kyc');
      expect(explanation.sanitizedContext.investorAddress).toBe(VALID_INVESTOR_1);
      expect(explanation.sanitizedContext.bondId).toBe(101);
      expect(explanation.retryCount).toBe(0);
    });

    it('should generate an actionable explanation for KYC_EXPIRED', async () => {
      const context: EligibilityEvaluationContext = {
        investorAddress: VALID_INVESTOR_1,
        bondId: 102,
        jurisdiction: 'EU',
        tranche: TrancheType.STANDARD,
      };

      const decision: EligibilityDecision = {
        eligible: false,
        code: 'KYC_EXPIRED',
        reason: 'KYC verification has expired; re-verification is required.',
        rulesetVersion: '2026.1',
        jurisdiction: 'EU',
        tranche: TrancheType.STANDARD,
        requiresAttestation: false,
        evaluatedRules: [{ ruleName: 'KYC_EXPIRATION_CHECK', passed: false }],
      };

      const explanation = await service.explainEligibilityRejection(context, decision);

      expect(explanation.code).toBe('KYC_EXPIRED');
      expect(explanation.category).toBe('IDENTITY_AND_KYC');
      expect(explanation.remediation.remediationType).toBe('DOCUMENT_UPLOAD');
      expect(explanation.remediation.isRetryable).toBe(true);
      expect(explanation.remediation.actionSteps.some((step) => step.includes('current identity documentation'))).toBe(true);
    });

    it('should generate an actionable explanation for ACCREDITATION_REQUIRED', async () => {
      const context: EligibilityEvaluationContext = {
        investorAddress: VALID_INVESTOR_1,
        bondId: 103,
        jurisdiction: 'US',
        tranche: TrancheType.RESTRICTED_ACCREDITED,
      };

      const decision: EligibilityDecision = {
        eligible: false,
        code: 'ACCREDITATION_REQUIRED',
        reason: 'Investor does not have accredited status required for restricted tranche.',
        rulesetVersion: '2026.1',
        jurisdiction: 'US',
        tranche: TrancheType.RESTRICTED_ACCREDITED,
        requiresAttestation: true,
        evaluatedRules: [{ ruleName: 'ACCREDITED_INVESTOR_REQUIREMENT', passed: false }],
      };

      const explanation = await service.explainEligibilityRejection(context, decision);

      expect(explanation.code).toBe('ACCREDITATION_REQUIRED');
      expect(explanation.category).toBe('REGULATORY_ACCREDITATION');
      expect(explanation.remediation.remediationType).toBe('DOCUMENT_UPLOAD');
      expect(explanation.remediation.remediationUrl).toBe('/compliance/accreditation');
      expect(explanation.detailedExplanation).toContain('Regulation D');
    });

    it('should generate an actionable explanation for OFFERING_CAP_EXCEEDED', async () => {
      const context: EligibilityEvaluationContext = {
        investorAddress: VALID_INVESTOR_1,
        bondId: 104,
        jurisdiction: 'SG',
        tranche: TrancheType.STANDARD,
        purchaseAmount: '50000000',
      };

      const decision: EligibilityDecision = {
        eligible: false,
        code: 'OFFERING_CAP_EXCEEDED',
        reason: 'Investment amount 50000000 exceeds the non-accredited investor cap of 20000000 for SG.',
        rulesetVersion: '2026.1',
        jurisdiction: 'SG',
        tranche: TrancheType.STANDARD,
        requiresAttestation: false,
        evaluatedRules: [{ ruleName: 'RETAIL_OFFERING_CAP_CHECK', passed: false }],
      };

      const explanation = await service.explainEligibilityRejection(context, decision);

      expect(explanation.code).toBe('OFFERING_CAP_EXCEEDED');
      expect(explanation.category).toBe('INVESTMENT_LIMITS');
      expect(explanation.remediation.remediationType).toBe('ADJUST_AMOUNT');
      expect(explanation.sanitizedContext.attemptedAmount).toBe('50000000');
    });

    it('should generate explanation for SANCTIONED_ADDRESS with isRetryable=false', async () => {
      const context: EligibilityEvaluationContext = {
        investorAddress: VALID_INVESTOR_1,
        bondId: 105,
        jurisdiction: 'GLOBAL',
        tranche: TrancheType.STANDARD,
      };

      const decision: EligibilityDecision = {
        eligible: false,
        code: 'SANCTIONED_ADDRESS',
        reason: 'Investor address is sanctioned.',
        rulesetVersion: '2026.1',
        jurisdiction: 'GLOBAL',
        tranche: TrancheType.STANDARD,
        requiresAttestation: false,
        evaluatedRules: [{ ruleName: 'SANCTIONS_SCREENING', passed: false }],
      };

      const explanation = await service.explainEligibilityRejection(context, decision);

      expect(explanation.code).toBe('SANCTIONED_ADDRESS');
      expect(explanation.category).toBe('JURISDICTIONAL_SANCTIONS');
      expect(explanation.remediation.remediationType).toBe('NON_REMEDIABLE');
      expect(explanation.remediation.isRetryable).toBe(false);
    });
  });

  describe('Normal Path: Transfer Rejections', () => {
    it('should explain recipient KYC missing on secondary transfer', async () => {
      const context: TransferEligibilityContext = {
        fromAddress: VALID_INVESTOR_1,
        toAddress: VALID_INVESTOR_2,
        fromJurisdiction: 'US',
        toJurisdiction: 'US',
        bondId: 201,
        tranche: TrancheType.STANDARD,
        amount: '1000',
      };

      const explanation = await service.explainTransferRejection(
        context,
        'Secondary transfer recipient non-compliant: KYC_REQUIRED',
      );

      expect(explanation.actionType).toBe('SECONDARY_TRANSFER');
      expect(explanation.code).toBe('TRANSFER_COUNTERPARTY_RESTRICTED');
      expect(explanation.category).toBe('IDENTITY_AND_KYC');
      expect(explanation.title).toBe('Recipient Must Complete Verification');
      expect(explanation.remediation.actionSteps[0]).toContain('identity verification');
      expect(explanation.sanitizedContext.counterpartyAddress).toBe(VALID_INVESTOR_2);
    });

    it('should explain insufficient balance on secondary transfer', async () => {
      const context: TransferEligibilityContext = {
        fromAddress: VALID_INVESTOR_1,
        toAddress: VALID_INVESTOR_2,
        fromJurisdiction: 'US',
        toJurisdiction: 'US',
        bondId: 202,
        tranche: TrancheType.STANDARD,
        amount: '1000000000',
      };

      const explanation = await service.explainTransferRejection(
        context,
        'INSUFFICIENT_SUPPLY',
      );

      expect(explanation.code).toBe('INSUFFICIENT_SUPPLY_OR_BALANCE');
      expect(explanation.category).toBe('BALANCE_AND_ESCROW');
      expect(explanation.remediation.remediationType).toBe('ADJUST_AMOUNT');
    });

    it('should explain matured bond status on secondary transfer', async () => {
      const context: TransferEligibilityContext = {
        fromAddress: VALID_INVESTOR_1,
        toAddress: VALID_INVESTOR_2,
        fromJurisdiction: 'US',
        toJurisdiction: 'US',
        bondId: 203,
        tranche: TrancheType.STANDARD,
        amount: '500',
      };

      const explanation = await service.explainTransferRejection(
        context,
        'BOND_ALREADY_MATURED',
      );

      expect(explanation.code).toBe('BOND_MATURED_OR_INACTIVE');
      expect(explanation.category).toBe('MARKET_AND_LIFECYCLE');
      expect(explanation.remediation.isRetryable).toBe(false);
      expect(explanation.remediation.remediationUrl).toBe('/redemption');
    });
  });

  describe('Failure Path: Input Validation', () => {
    it('should reject invalid Stellar investor address with BadRequestException', async () => {
      const context: EligibilityEvaluationContext = {
        investorAddress: INVALID_ADDRESS,
        bondId: 101,
        jurisdiction: 'US',
        tranche: TrancheType.STANDARD,
      };

      const decision: EligibilityDecision = {
        eligible: false,
        code: 'KYC_REQUIRED',
        rulesetVersion: '2026.1',
        jurisdiction: 'US',
        tranche: TrancheType.STANDARD,
        requiresAttestation: false,
        evaluatedRules: [],
      };

      await expect(service.explainEligibilityRejection(context, decision)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject invalid bond ID with BadRequestException', async () => {
      const context: EligibilityEvaluationContext = {
        investorAddress: VALID_INVESTOR_1,
        bondId: -5,
        jurisdiction: 'US',
        tranche: TrancheType.STANDARD,
      };

      const decision: EligibilityDecision = {
        eligible: false,
        code: 'KYC_REQUIRED',
        rulesetVersion: '2026.1',
        jurisdiction: 'US',
        tranche: TrancheType.STANDARD,
        requiresAttestation: false,
        evaluatedRules: [],
      };

      await expect(service.explainEligibilityRejection(context, decision)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject negative amount with BadRequestException', async () => {
      const context: EligibilityEvaluationContext = {
        investorAddress: VALID_INVESTOR_1,
        bondId: 101,
        jurisdiction: 'US',
        tranche: TrancheType.STANDARD,
        purchaseAmount: '-500',
      };

      const decision: EligibilityDecision = {
        eligible: false,
        code: 'KYC_REQUIRED',
        rulesetVersion: '2026.1',
        jurisdiction: 'US',
        tranche: TrancheType.STANDARD,
        requiresAttestation: false,
        evaluatedRules: [],
      };

      await expect(service.explainEligibilityRejection(context, decision)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException for non-existent audit ID', async () => {
      await expect(service.getExplanation('non-existent-audit-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('Retry Path: Idempotency', () => {
    it('should increment retryCount without duplicating audit records on repeated failure', async () => {
      const context: EligibilityEvaluationContext = {
        investorAddress: VALID_INVESTOR_1,
        bondId: 301,
        jurisdiction: 'US',
        tranche: TrancheType.STANDARD,
      };

      const decision: EligibilityDecision = {
        eligible: false,
        code: 'KYC_REQUIRED',
        rulesetVersion: '2026.1',
        jurisdiction: 'US',
        tranche: TrancheType.STANDARD,
        requiresAttestation: false,
        evaluatedRules: [],
      };

      // First evaluation
      const expl1 = await service.explainEligibilityRejection(context, decision);
      expect(expl1.retryCount).toBe(0);
      const originalAuditId = expl1.auditId;

      // Second evaluation (user retrying before KYC done)
      const expl2 = await service.explainEligibilityRejection(context, decision);
      expect(expl2.auditId).toBe(originalAuditId);
      expect(expl2.retryCount).toBe(1);

      // Third retry
      const expl3 = await service.explainEligibilityRejection(context, decision);
      expect(expl3.auditId).toBe(originalAuditId);
      expect(expl3.retryCount).toBe(2);

      // Verify list contains only one aggregated record
      const list = await service.listInvestorRejections(VALID_INVESTOR_1);
      expect(list.filter((e) => e.auditId === originalAuditId)).toHaveLength(1);
    });
  });

  describe('Authorization Path', () => {
    let explanation: InvestorRejectionExplanationDto;

    beforeEach(async () => {
      explanation = await service.explainEligibilityRejection(
        {
          investorAddress: VALID_INVESTOR_1,
          bondId: 401,
          jurisdiction: 'US',
          tranche: TrancheType.STANDARD,
        },
        {
          eligible: false,
          code: 'KYC_REQUIRED',
          rulesetVersion: '2026.1',
          jurisdiction: 'US',
          tranche: TrancheType.STANDARD,
          requiresAttestation: false,
          evaluatedRules: [],
        },
      );
    });

    it('should allow the affected investor to access their own explanation', async () => {
      const requestingUser: AuthenticatedUser = {
        walletAddress: VALID_INVESTOR_1,
        kycStatus: KycStatus.NONE,
      };

      const result = await service.getExplanation(explanation.auditId, requestingUser);
      expect(result.auditId).toBe(explanation.auditId);
    });

    it('should allow compliance admin to access any investor explanation', async () => {
      const adminUser: AuthenticatedUser = {
        walletAddress: 'GADMINWALLET...',
        kycStatus: KycStatus.VERIFIED,
        roles: ['admin'],
      };

      const result = await service.getExplanation(explanation.auditId, adminUser);
      expect(result.auditId).toBe(explanation.auditId);
    });

    it('should reject unauthorized third party with ForbiddenException', async () => {
      const eavesdropper: AuthenticatedUser = {
        walletAddress: VALID_INVESTOR_2,
        kycStatus: KycStatus.VERIFIED,
      };

      await expect(service.getExplanation(explanation.auditId, eavesdropper)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should reject unauthorized listing of another investor’s rejections', async () => {
      const eavesdropper: AuthenticatedUser = {
        walletAddress: VALID_INVESTOR_2,
        kycStatus: KycStatus.VERIFIED,
      };

      await expect(
        service.listInvestorRejections(VALID_INVESTOR_1, eavesdropper),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
