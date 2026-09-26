import { Injectable, Logger } from '@nestjs/common';
import {
  EligibilityDecision,
  EligibilityEvaluationContext,
  EvaluatedRuleResult,
  JurisdictionRule,
  TrancheType,
  VersionedRuleset,
} from '../interfaces/compliance.interface';
import { CANONICAL_RULESET_V2026_1 } from '../rules/default-ruleset';
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
}
