import { ComplianceRulesEngine } from './compliance-rules.engine';
import { SanctionsService } from './sanctions.service';
import { TrancheType } from '../interfaces/compliance.interface';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';
import { CANONICAL_RULESET_V2026_1, computeRulesetAuditHash } from '../rules/default-ruleset';

describe('ComplianceRulesEngine', () => {
  let engine: ComplianceRulesEngine;
  let sanctionsService: SanctionsService;

  const TEST_INVESTOR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  beforeEach(() => {
    sanctionsService = new SanctionsService();
    engine = new ComplianceRulesEngine(sanctionsService);
  });

  describe('Ruleset versioning and audit hash determinism', () => {
    it('initializes with canonical v2026.1 ruleset', () => {
      const active = engine.getActiveRuleset();
      expect(active.version).toBe('2026.1');
      expect(active.auditHash).toBeDefined();
      expect(active.auditHash).toHaveLength(64); // 256-bit hex hash
    });

    it('computes deterministic SHA-256 audit hash over canonical serialization', () => {
      const hash1 = computeRulesetAuditHash(CANONICAL_RULESET_V2026_1);
      const hash2 = computeRulesetAuditHash(CANONICAL_RULESET_V2026_1);
      expect(hash1).toBe(hash2);
      expect(hash1).toBe(CANONICAL_RULESET_V2026_1.auditHash);
    });

    it('retrieves specific jurisdiction rule with case-insensitive code', () => {
      const ruleUs = engine.getJurisdictionRule('us');
      expect(ruleUs.jurisdiction).toBe('US');
      expect(ruleUs.requireAccreditationForRestricted).toBe(true);

      const ruleUnknown = engine.getJurisdictionRule('ZZ');
      expect(ruleUnknown.jurisdiction).toBe('GLOBAL');
    });
  });

  describe('Jurisdiction Ruleset 1: United States (US)', () => {
    it('allows standard tranche for KYC-verified investor', () => {
      const decision = engine.evaluateEligibility({
        investorAddress: TEST_INVESTOR,
        bondId: 1,
        tranche: TrancheType.STANDARD,
        jurisdiction: 'US',
        kycRecord: { status: KycStatus.VERIFIED },
      });

      expect(decision.eligible).toBe(true);
      expect(decision.code).toBe('ELIGIBLE');
      expect(decision.requiresAttestation).toBe(false);
    });

    it('requires accreditation for restricted tranche; rejects non-accredited verified investor', () => {
      const decision = engine.evaluateEligibility({
        investorAddress: TEST_INVESTOR,
        bondId: 1,
        tranche: TrancheType.RESTRICTED_ACCREDITED,
        jurisdiction: 'US',
        kycRecord: { status: KycStatus.VERIFIED }, // Verified but not accredited
      });

      expect(decision.eligible).toBe(false);
      expect(decision.code).toBe('ACCREDITATION_REQUIRED');
      expect(decision.requiresAttestation).toBe(true);
    });

    it('approves restricted tranche for accredited investor with attestation requirement flagged', () => {
      const decision = engine.evaluateEligibility({
        investorAddress: TEST_INVESTOR,
        bondId: 1,
        tranche: TrancheType.RESTRICTED_ACCREDITED,
        jurisdiction: 'US',
        kycRecord: { status: KycStatus.ACCREDITED },
      });

      expect(decision.eligible).toBe(true);
      expect(decision.code).toBe('ELIGIBLE');
      expect(decision.requiresAttestation).toBe(true);
    });

    it('rejects investor without KYC', () => {
      const decision = engine.evaluateEligibility({
        investorAddress: TEST_INVESTOR,
        bondId: 1,
        tranche: TrancheType.STANDARD,
        jurisdiction: 'US',
        kycRecord: { status: KycStatus.NONE },
      });

      expect(decision.eligible).toBe(false);
      expect(decision.code).toBe('KYC_REQUIRED');
    });

    it('rejects investor with expired KYC', () => {
      const past = Date.now() - 10000;
      const decision = engine.evaluateEligibility({
        investorAddress: TEST_INVESTOR,
        bondId: 1,
        tranche: TrancheType.STANDARD,
        jurisdiction: 'US',
        kycRecord: { status: KycStatus.VERIFIED, expiresAt: past },
      });

      expect(decision.eligible).toBe(false);
      expect(decision.code).toBe('KYC_EXPIRED');
    });
  });

  describe('Jurisdiction Ruleset 2: European Union (EU) & Singapore (SG)', () => {
    it('allows standard tranche purchase under retail offering cap in EU', () => {
      const decision = engine.evaluateEligibility({
        investorAddress: TEST_INVESTOR,
        bondId: 2,
        tranche: TrancheType.STANDARD,
        jurisdiction: 'EU',
        purchaseAmount: '5000', // Under cap (25,000)
        kycRecord: { status: KycStatus.VERIFIED },
      });

      expect(decision.eligible).toBe(true);
      expect(decision.code).toBe('ELIGIBLE');
    });

    it('rejects standard tranche retail purchase exceeding offering cap for non-accredited in EU', () => {
      const decision = engine.evaluateEligibility({
        investorAddress: TEST_INVESTOR,
        bondId: 2,
        tranche: TrancheType.STANDARD,
        jurisdiction: 'EU',
        purchaseAmount: '50000', // Exceeds cap (25,000)
        kycRecord: { status: KycStatus.VERIFIED },
      });

      expect(decision.eligible).toBe(false);
      expect(decision.code).toBe('OFFERING_CAP_EXCEEDED');
      expect(decision.reason).toContain('exceeds the non-accredited investor cap');
    });

    it('exempts accredited investor from retail offering cap in EU', () => {
      const decision = engine.evaluateEligibility({
        investorAddress: TEST_INVESTOR,
        bondId: 2,
        tranche: TrancheType.STANDARD,
        jurisdiction: 'EU',
        purchaseAmount: '100000', // Above retail cap, but investor is accredited
        kycRecord: { status: KycStatus.ACCREDITED },
      });

      expect(decision.eligible).toBe(true);
      expect(decision.code).toBe('ELIGIBLE');
    });

    it('evaluates Singapore (SG) ruleset: allows accredited on restricted tranche, rejects unpermitted tranches', () => {
      const allowed = engine.evaluateEligibility({
        investorAddress: TEST_INVESTOR,
        bondId: 3,
        tranche: TrancheType.RESTRICTED_ACCREDITED,
        jurisdiction: 'SG',
        kycRecord: { status: KycStatus.ACCREDITED },
      });

      expect(allowed.eligible).toBe(true);
      expect(allowed.jurisdiction).toBe('SG');

      const rejectedTranche = engine.evaluateEligibility({
        investorAddress: TEST_INVESTOR,
        bondId: 3,
        tranche: TrancheType.GREEN_INSTITUTIONAL,
        jurisdiction: 'SG',
        kycRecord: { status: KycStatus.ACCREDITED },
      });

      expect(rejectedTranche.eligible).toBe(false);
      expect(rejectedTranche.code).toBe('TRANCHE_NOT_PERMITTED');
    });
  });

  describe('Sanctioned and Embargoed Jurisdiction handling', () => {
    it('blocks investors from sanctioned or embargoed countries (e.g. CU, KP, SY)', () => {
      const decision = engine.evaluateEligibility({
        investorAddress: TEST_INVESTOR,
        bondId: 1,
        tranche: TrancheType.STANDARD,
        jurisdiction: 'CU',
        kycRecord: { status: KycStatus.VERIFIED },
      });

      expect(decision.eligible).toBe(false);
      expect(decision.code).toBe('SANCTIONED_JURISDICTION');
    });

    it('blocks sanctioned wallet address across any jurisdiction', () => {
      const sanctionedWallet = 'GSANCTIONEDWALLETHOLDINGILLICITFUNDS00000000000000000000';
      sanctionsService.addSanctionedAddress(sanctionedWallet, 'OFAC SDN List test');

      const decision = engine.evaluateEligibility({
        investorAddress: sanctionedWallet,
        bondId: 1,
        tranche: TrancheType.STANDARD,
        jurisdiction: 'US',
        kycRecord: { status: KycStatus.ACCREDITED },
      });

      expect(decision.eligible).toBe(false);
      expect(decision.code).toBe('SANCTIONED_ADDRESS');
    });
  });
});
