import { KycCommitmentService, EligibilityTier } from './kyc-commitment.service';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';
import { UnauthorizedException, NotFoundException } from '@nestjs/common';

describe('KycCommitmentService (KYC Data Minimization & Selective Disclosure)', () => {
  let service: KycCommitmentService;
  const TEST_INVESTOR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  beforeEach(() => {
    service = new KycCommitmentService();
  });

  describe('1. No PII on-chain (Eligibility commitments & non-identifying tiers)', () => {
    it('generates on-chain commitment without exposing investor PII in the payload', () => {
      const commitment = service.generateOnChainCommitment({
        investorAddress: TEST_INVESTOR,
        kycStatus: KycStatus.VERIFIED,
        jurisdiction: 'US',
      });

      expect(commitment.commitmentHash).toBeDefined();
      expect(commitment.commitmentHash).toHaveLength(64); // SHA-256 hash
      expect(commitment.eligibilityTier).toBe(EligibilityTier.TIER_1_RETAIL_STANDARD);
      expect(JSON.stringify(commitment)).not.toContain(TEST_INVESTOR);
      expect(JSON.stringify(commitment)).not.toContain('US');
    });

    it('maps accredited status to TIER_2_ACCREDITED non-identifying tier', () => {
      const commitment = service.generateOnChainCommitment({
        investorAddress: TEST_INVESTOR,
        kycStatus: KycStatus.ACCREDITED,
        jurisdiction: 'EU',
      });

      expect(commitment.eligibilityTier).toBe(EligibilityTier.TIER_2_ACCREDITED);
    });
  });

  describe('2. On-chain eligibility enforcement at purchase time without PII', () => {
    it('approves purchase when commitment tier satisfies required tier', () => {
      const commitment = service.generateOnChainCommitment({
        investorAddress: TEST_INVESTOR,
        kycStatus: KycStatus.ACCREDITED,
        jurisdiction: 'US',
      });

      const verification = service.verifyOnChainEligibilityFromCommitment(
        commitment,
        EligibilityTier.TIER_1_RETAIL_STANDARD,
      );

      expect(verification.eligible).toBe(true);
    });

    it('rejects purchase when commitment tier is lower than required tier', () => {
      const commitment = service.generateOnChainCommitment({
        investorAddress: TEST_INVESTOR,
        kycStatus: KycStatus.VERIFIED, // Tier 1
        jurisdiction: 'US',
      });

      const verification = service.verifyOnChainEligibilityFromCommitment(
        commitment,
        EligibilityTier.TIER_2_ACCREDITED, // Requires Tier 2
      );

      expect(verification.eligible).toBe(false);
      expect(verification.reason).toContain('insufficient');
    });

    it('rejects expired commitment', () => {
      const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;
      const commitment = service.generateOnChainCommitment({
        investorAddress: TEST_INVESTOR,
        kycStatus: KycStatus.VERIFIED,
        jurisdiction: 'US',
        expiresAt: pastTimestamp * 1000,
      });

      const verification = service.verifyOnChainEligibilityFromCommitment(
        commitment,
        EligibilityTier.TIER_1_RETAIL_STANDARD,
      );

      expect(verification.eligible).toBe(false);
      expect(verification.reason).toContain('expired');
    });
  });

  describe('3. Selective disclosure process for authorized regulators', () => {
    it('allows authorized regulator with valid credentials to obtain selective disclosure package', () => {
      const commitment = service.generateOnChainCommitment({
        investorAddress: TEST_INVESTOR,
        kycStatus: KycStatus.ACCREDITED,
        jurisdiction: 'US',
        providerReference: 'SEC_AUDIT_REF_12345',
      });

      const disclosure = service.generateRegulatorDisclosurePackage(
        {
          regulatorId: 'REGULATOR_SEC',
          authorizationToken: 'AUTH_TOKEN_REGULATOR_SEC',
          commitmentHash: commitment.commitmentHash,
        },
        'ANNUAL_COMPLIANCE_AUDIT',
      );

      expect(disclosure.proofValid).toBe(true);
      expect(disclosure.investorAddress).toBe(TEST_INVESTOR);
      expect(disclosure.jurisdiction).toBe('US');
      expect(disclosure.kycStatus).toBe(KycStatus.ACCREDITED);
      expect(disclosure.disclosureMetadata.disclosedTo).toBe('REGULATOR_SEC');
    });

    it('rejects unauthorized regulator requests', () => {
      const commitment = service.generateOnChainCommitment({
        investorAddress: TEST_INVESTOR,
        kycStatus: KycStatus.VERIFIED,
        jurisdiction: 'EU',
      });

      expect(() =>
        service.generateRegulatorDisclosurePackage({
          regulatorId: 'UNAUTHORIZED_ENTITY',
          authorizationToken: 'INVALID_TOKEN',
          commitmentHash: commitment.commitmentHash,
        }),
      ).toThrow(UnauthorizedException);
    });

    it('throws NotFoundException for non-existent commitment hash', () => {
      expect(() =>
        service.generateRegulatorDisclosurePackage({
          regulatorId: 'REGULATOR_SEC',
          authorizationToken: 'AUTH_TOKEN_REGULATOR_SEC',
          commitmentHash: '0000000000000000000000000000000000000000000000000000000000000000',
        }),
      ).toThrow(NotFoundException);
    });
  });
});
