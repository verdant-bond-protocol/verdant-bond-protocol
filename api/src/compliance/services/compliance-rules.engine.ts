import { Injectable, Logger } from '@nestjs/common';
import {
  EligibilityDecision,
  EligibilityEvaluationContext,
  EvaluatedRuleResult,
  JurisdictionRule,
  TrancheType,
  VersionedRuleset,
} from '../interfaces/compliance.interface';
import { CANONICAL_RULESET_V2026_1, computeRulesetAuditHash } from '../rules/default-ruleset';
import { SanctionsService } from './sanctions.service';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';

@Injectable()
export class ComplianceRulesEngine {
  private readonly logger = new Logger(ComplianceRulesEngine.name);
  private rulesets: Map<string, VersionedRuleset> = new Map();
  private activeVersion: string;

  constructor(private readonly sanctionsService: SanctionsService) {
    this.registerRuleset(CANONICAL_RULESET_V2026_1);
    this.activeVersion = CANONICAL_RULESET_V2026_1.version;
  }

  registerRuleset(ruleset: VersionedRuleset): void {
    this.rulesets.set(ruleset.version, ruleset);
    this.logger.log(
      `Registered versioned ruleset ${ruleset.version} (Audit Hash: ${ruleset.auditHash.slice(0, 16)}...)`,
    );
  }

  getActiveRuleset(): VersionedRuleset {
    return this.rulesets.get(this.activeVersion)!;
  }

  getRuleset(version?: string): VersionedRuleset {
    if (version && this.rulesets.has(version)) {
      return this.rulesets.get(version)!;
    }
    return this.getActiveRuleset();
  }

  getJurisdictionRule(jurisdiction: string, rulesetVersion?: string): JurisdictionRule {
    const ruleset = this.getRuleset(rulesetVersion);
    const upper = jurisdiction.toUpperCase();
    return ruleset.jurisdictions[upper] ?? ruleset.defaultRule;
  }

  getSanctionsService(): SanctionsService {
    return this.sanctionsService;
  }

  /**
   * Evaluates investor eligibility across jurisdiction rules, tranche constraints,
   * KYC status, sanctions, and investment caps.
   */
  evaluateEligibility(context: EligibilityEvaluationContext): EligibilityDecision {
    const ruleset = this.getActiveRuleset();
    const evaluatedRules: EvaluatedRuleResult[] = [];
    const jurisdiction = (context.jurisdiction || 'GLOBAL').toUpperCase();
    const tranche = context.tranche || TrancheType.STANDARD;
    const rule = this.getJurisdictionRule(jurisdiction, ruleset.version);

    // 1. Sanctions screening check (Address & Country)
    const sanctionsCheck = this.sanctionsService.checkSanctions(
      context.investorAddress,
      jurisdiction,
    );
    if (sanctionsCheck.sanctioned) {
      const isCountry = sanctionsCheck.list?.includes('COMPREHENSIVE');
      evaluatedRules.push({
        ruleName: 'SANCTIONS_SCREENING',
        passed: false,
        reason: sanctionsCheck.reason,
      });
      return {
        eligible: false,
        code: isCountry ? 'SANCTIONED_JURISDICTION' : 'SANCTIONED_ADDRESS',
        reason: sanctionsCheck.reason,
        rulesetVersion: ruleset.version,
        jurisdiction,
        tranche,
        requiresAttestation: false,
        evaluatedRules,
      };
    }
    evaluatedRules.push({ ruleName: 'SANCTIONS_SCREENING', passed: true });

    // 2. Embargoed jurisdiction check
    if (rule.isSanctionedOrEmbargoed) {
      evaluatedRules.push({
        ruleName: 'EMBARGOED_JURISDICTION_CHECK',
        passed: false,
        reason: `Jurisdiction ${jurisdiction} is blocked from all offerings.`,
      });
      return {
        eligible: false,
        code: 'SANCTIONED_JURISDICTION',
        reason: `Jurisdiction ${jurisdiction} is blocked under international sanctions.`,
        rulesetVersion: ruleset.version,
        jurisdiction,
        tranche,
        requiresAttestation: false,
        evaluatedRules,
      };
    }
    evaluatedRules.push({ ruleName: 'EMBARGOED_JURISDICTION_CHECK', passed: true });

    // 3. Tranche permission check
    if (!rule.allowedTranches.includes(tranche)) {
      evaluatedRules.push({
        ruleName: 'TRANCHE_ALLOWED_FOR_JURISDICTION',
        passed: false,
        reason: `Tranche ${tranche} is not permitted for offering in jurisdiction ${jurisdiction}.`,
      });
      return {
        eligible: false,
        code: 'TRANCHE_NOT_PERMITTED',
        reason: `Tranche ${tranche} cannot be offered to investors in ${jurisdiction}.`,
        rulesetVersion: ruleset.version,
        jurisdiction,
        tranche,
        requiresAttestation: false,
        evaluatedRules,
      };
    }
    evaluatedRules.push({ ruleName: 'TRANCHE_ALLOWED_FOR_JURISDICTION', passed: true });

    // 4. KYC Status check
    const kycStatus = context.kycRecord?.status ?? KycStatus.NONE;
    const expiresAt = context.kycRecord?.expiresAt ?? null;

    if (expiresAt && expiresAt < Date.now()) {
      evaluatedRules.push({
        ruleName: 'KYC_EXPIRATION_CHECK',
        passed: false,
        reason: 'KYC verification has expired; re-verification is required.',
      });
      return {
        eligible: false,
        code: 'KYC_EXPIRED',
        reason: 'KYC verification has expired; re-verification is required.',
        rulesetVersion: ruleset.version,
        jurisdiction,
        tranche,
        requiresAttestation: false,
        evaluatedRules,
      };
    }
    evaluatedRules.push({ ruleName: 'KYC_EXPIRATION_CHECK', passed: true });

    const isVerifiedOrBetter =
      kycStatus === KycStatus.VERIFIED || kycStatus === KycStatus.ACCREDITED;

    if (!isVerifiedOrBetter) {
      evaluatedRules.push({
        ruleName: 'MINIMUM_KYC_STATUS_CHECK',
        passed: false,
        reason: `Requires completed KYC verification (Current: ${kycStatus}).`,
      });
      return {
        eligible: false,
        code: 'KYC_REQUIRED',
        reason: `KYC verification is required before investing in bond ${context.bondId}.`,
        rulesetVersion: ruleset.version,
        jurisdiction,
        tranche,
        requiresAttestation: false,
        evaluatedRules,
      };
    }
    evaluatedRules.push({ ruleName: 'MINIMUM_KYC_STATUS_CHECK', passed: true });

    // 5. Restricted tranche accreditation check
    const isRestrictedTranche = tranche === TrancheType.RESTRICTED_ACCREDITED;
    if (isRestrictedTranche && rule.requireAccreditationForRestricted) {
      if (kycStatus !== KycStatus.ACCREDITED) {
        evaluatedRules.push({
          ruleName: 'ACCREDITED_INVESTOR_REQUIREMENT',
          passed: false,
          reason: `Tranche ${tranche} in jurisdiction ${jurisdiction} requires accredited investor status.`,
        });
        return {
          eligible: false,
          code: 'ACCREDITATION_REQUIRED',
          reason: `Investor does not have accredited status required for restricted tranche ${tranche} in ${jurisdiction}.`,
          rulesetVersion: ruleset.version,
          jurisdiction,
          tranche,
          requiresAttestation: true,
          evaluatedRules,
        };
      }
      evaluatedRules.push({ ruleName: 'ACCREDITED_INVESTOR_REQUIREMENT', passed: true });
    }

    // 6. Offering cap check for retail (non-accredited) investors
    if (
      kycStatus !== KycStatus.ACCREDITED &&
      rule.maxRetailOfferingCap &&
      context.purchaseAmount
    ) {
      const cap = BigInt(rule.maxRetailOfferingCap);
      const amount = BigInt(context.purchaseAmount);
      if (amount > cap) {
        evaluatedRules.push({
          ruleName: 'RETAIL_OFFERING_CAP_CHECK',
          passed: false,
          reason: `Purchase amount ${amount} exceeds jurisdiction retail cap ${cap}.`,
        });
        return {
          eligible: false,
          code: 'OFFERING_CAP_EXCEEDED',
          reason: `Investment amount ${amount} exceeds the non-accredited investor cap of ${cap} for ${jurisdiction}.`,
          rulesetVersion: ruleset.version,
          jurisdiction,
          tranche,
          requiresAttestation: false,
          evaluatedRules,
        };
      }
      evaluatedRules.push({ ruleName: 'RETAIL_OFFERING_CAP_CHECK', passed: true });
    }

    return {
      eligible: true,
      code: 'ELIGIBLE',
      rulesetVersion: ruleset.version,
      jurisdiction,
      tranche,
      requiresAttestation: isRestrictedTranche,
      evaluatedRules,
    };
  }

  /**
   * Governance-updatable rules table method. Updates a jurisdiction rule dynamically
   * in the active ruleset without requiring a contract or service redeploy.
   */
  updateJurisdictionRule(
    jurisdiction: string,
    ruleUpdates: Partial<JurisdictionRule>,
    governanceActor: string = 'GOVERNANCE_MULTISIG',
  ): VersionedRuleset {
    const activeRuleset = this.getActiveRuleset();
    const upper = jurisdiction.toUpperCase();
    const currentRule = this.getJurisdictionRule(upper, activeRuleset.version);

    const updatedJurisdictions = {
      ...activeRuleset.jurisdictions,
      [upper]: {
        ...currentRule,
        ...ruleUpdates,
        jurisdiction: upper,
      },
    };

    const newRawRuleset = {
      version: `${activeRuleset.version}.upd`,
      effectiveDate: new Date().toISOString(),
      jurisdictions: updatedJurisdictions,
      defaultRule: activeRuleset.defaultRule,
    };

    const newAuditHash = computeRulesetAuditHash(newRawRuleset);
    const newRuleset: VersionedRuleset = {
      ...newRawRuleset,
      auditHash: newAuditHash,
    };

    this.registerRuleset(newRuleset);
    this.activeVersion = newRuleset.version;

    this.logger.log(
      `Governance action by ${governanceActor}: updated rule for jurisdiction ${upper}. New ruleset version: ${newRuleset.version}`,
    );

    return newRuleset;
  }

  /**
   * Evaluates compliance eligibility for secondary-market transfers.
   * Enforces rules consistently across both recipient eligibility and sender status.
   */
  evaluateTransferEligibility(
    context: import('../interfaces/compliance.interface').TransferEligibilityContext,
  ): EligibilityDecision {
    // Evaluates recipient eligibility at secondary transfer
    const recipientDecision = this.evaluateEligibility({
      investorAddress: context.toAddress,
      jurisdiction: context.toJurisdiction,
      tranche: context.tranche,
      bondId: context.bondId,
      purchaseAmount: context.amount,
      kycRecord: context.toKycRecord,
    });

    if (!recipientDecision.eligible) {
      return {
        ...recipientDecision,
        reason: `Secondary transfer recipient non-compliant: ${recipientDecision.reason}`,
      };
    }

    // Evaluates sender sanctions status
    const senderSanctions = this.sanctionsService.checkSanctions(
      context.fromAddress,
      context.fromJurisdiction,
    );
    if (senderSanctions.sanctioned) {
      return {
        eligible: false,
        code: 'SANCTIONED_ADDRESS',
        reason: `Secondary transfer sender is sanctioned: ${senderSanctions.reason}`,
        rulesetVersion: this.activeVersion,
        jurisdiction: context.fromJurisdiction,
        tranche: context.tranche,
        requiresAttestation: false,
        evaluatedRules: [
          { ruleName: 'SENDER_SANCTIONS_CHECK', passed: false, reason: senderSanctions.reason },
        ],
      };
    }

    return recipientDecision;
  }

  /**
   * Evaluates existing position holders after a rule or jurisdiction change.
   * Implements a defined, non-punitive handling path (forced-sale grace period window)
   * rather than an instant freeze.
   */
  evaluatePostRuleChangeCompliance(context: {
    holderAddress: string;
    jurisdiction: string;
    bondId: number;
    tranche: TrancheType;
    holdingAmount: string;
    holdingAcquiredTimestamp: number; // Unix timestamp in ms
    ruleChangedTimestamp?: number; // Unix timestamp in ms
    gracePeriodDays?: number;
    kycRecord?: {
      status: KycStatus;
      expiresAt?: number | null;
    };
  }): import('../interfaces/compliance.interface').PostRuleChangeComplianceCheck {
    const currentEligibility = this.evaluateEligibility({
      investorAddress: context.holderAddress,
      jurisdiction: context.jurisdiction,
      tranche: context.tranche,
      bondId: context.bondId,
      purchaseAmount: context.holdingAmount,
      kycRecord: context.kycRecord,
    });

    if (currentEligibility.eligible) {
      return {
        status: import('../interfaces/compliance.interface').PostRuleChangeComplianceStatus.COMPLIANT,
        holderAddress: context.holderAddress,
        bondId: context.bondId,
        tranche: context.tranche,
        holdingAmount: context.holdingAmount,
        jurisdiction: context.jurisdiction,
        violations: [],
      };
    }

    const graceDays = context.gracePeriodDays ?? 30;
    const baseTime = context.ruleChangedTimestamp ?? context.holdingAcquiredTimestamp;
    const gracePeriodExpiresAt = baseTime + graceDays * 86400 * 1000;
    const now = Date.now();

    const failedRules = currentEligibility.evaluatedRules.filter((r) => !r.passed);

    if (now < gracePeriodExpiresAt) {
      return {
        status: import('../interfaces/compliance.interface').PostRuleChangeComplianceStatus.NON_COMPLIANT_GRACE_PERIOD,
        holderAddress: context.holderAddress,
        bondId: context.bondId,
        tranche: context.tranche,
        holdingAmount: context.holdingAmount,
        jurisdiction: context.jurisdiction,
        gracePeriodExpiresAt,
        forcedSaleWindowDays: graceDays,
        actionRequired: `Holder must sell/divest position or update compliance status before grace period expires at ${new Date(gracePeriodExpiresAt).toISOString()}`,
        violations: failedRules,
      };
    }

    return {
      status: import('../interfaces/compliance.interface').PostRuleChangeComplianceStatus.NON_COMPLIANT_EXPIRED,
      holderAddress: context.holderAddress,
      bondId: context.bondId,
      tranche: context.tranche,
      holdingAmount: context.holdingAmount,
      jurisdiction: context.jurisdiction,
      gracePeriodExpiresAt,
      forcedSaleWindowDays: graceDays,
      actionRequired: 'Grace period expired. Position frozen for secondary accumulation; forced liquidation or governance resolution required.',
      violations: failedRules,
    };
  }
}

