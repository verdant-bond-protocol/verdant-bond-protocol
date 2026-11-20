import { ComplianceAttestationService } from './compliance-attestation.service';
import { ComplianceRulesEngine } from './compliance-rules.engine';
import { SanctionsService } from './sanctions.service';
import { KycStoreService } from '../../common/services/kyc-store.service';
import { TrancheType } from '../interfaces/compliance.interface';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';
import { ForbiddenException } from '@nestjs/common';

describe('ComplianceAttestationService', () => {
  let attestationService: ComplianceAttestationService;
  let rulesEngine: ComplianceRulesEngine;
  let sanctionsService: SanctionsService;
  let mockKycStore: Partial<KycStoreService>;

  const INVESTOR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const OTHER_INVESTOR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  beforeEach(() => {
    sanctionsService = new SanctionsService();
    rulesEngine = new ComplianceRulesEngine(sanctionsService);

    mockKycStore = {
      get: jest.fn().mockImplementation(async (address: string) => {
        if (address === INVESTOR) {
          return {
            walletAddress: INVESTOR,
            status: KycStatus.ACCREDITED,
            source: 'test',
            updatedAt: Date.now(),
            expiresAt: Date.now() + 86400000,
          };
        }
        return null;
      }),
    };

    attestationService = new ComplianceAttestationService(
      rulesEngine,
      mockKycStore as KycStoreService,
    );
  });

  describe('issueAttestation', () => {
    it('issues cryptographically signed attestation for accredited investor on restricted tranche', async () => {
      const attestation = await attestationService.issueAttestation({
        investorAddress: INVESTOR,
        bondId: 42,
        tranche: TrancheType.RESTRICTED_ACCREDITED,
        jurisdiction: 'US',
      });

      expect(attestation).toBeDefined();
      expect(attestation.signature).toBeDefined();
      expect(attestation.signerPublicKey).toBeDefined();
      expect(attestation.payload.investorAddress).toBe(INVESTOR);
      expect(attestation.payload.bondId).toBe(42);
      expect(attestation.payload.tranche).toBe(TrancheType.RESTRICTED_ACCREDITED);
      expect(attestation.payload.jurisdiction).toBe('US');
      expect(attestation.payload.kycStatus).toBe(KycStatus.ACCREDITED);
      expect(attestation.payload.expiresAt).toBeGreaterThan(attestation.payload.issuedAt);
    });

    it('rejects attestation issuance when no KYC record exists', async () => {
      await expect(
        attestationService.issueAttestation({
          investorAddress: OTHER_INVESTOR,
          bondId: 42,
          tranche: TrancheType.RESTRICTED_ACCREDITED,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects attestation issuance when investor is non-accredited on US restricted tranche', async () => {
      (mockKycStore.get as jest.Mock).mockResolvedValueOnce({
        walletAddress: INVESTOR,
        status: KycStatus.VERIFIED, // Not accredited
        source: 'test',
        updatedAt: Date.now(),
      });

      await expect(
        attestationService.issueAttestation({
          investorAddress: INVESTOR,
          bondId: 42,
          tranche: TrancheType.RESTRICTED_ACCREDITED,
          jurisdiction: 'US',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('verifyAttestation (Independent Verification)', () => {
    it('verifies a valid signed attestation independently', async () => {
      const attestation = await attestationService.issueAttestation({
        investorAddress: INVESTOR,
        bondId: 42,
        tranche: TrancheType.RESTRICTED_ACCREDITED,
        jurisdiction: 'US',
      });

      const result = attestationService.verifyAttestation(attestation, {
        expectedInvestor: INVESTOR,
        expectedBondId: 42,
        expectedTranche: TrancheType.RESTRICTED_ACCREDITED,
      });

      expect(result.valid).toBe(true);
      expect(result.payload?.investorAddress).toBe(INVESTOR);
    });

    it('rejects attestation when expected investor does not match', async () => {
      const attestation = await attestationService.issueAttestation({
        investorAddress: INVESTOR,
        bondId: 42,
        tranche: TrancheType.RESTRICTED_ACCREDITED,
        jurisdiction: 'US',
      });

      const result = attestationService.verifyAttestation(attestation, {
        expectedInvestor: OTHER_INVESTOR,
        expectedBondId: 42,
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('does not match expected investor');
    });

    it('rejects attestation when expected bondId does not match', async () => {
      const attestation = await attestationService.issueAttestation({
        investorAddress: INVESTOR,
        bondId: 42,
        tranche: TrancheType.RESTRICTED_ACCREDITED,
        jurisdiction: 'US',
      });

      const result = attestationService.verifyAttestation(attestation, {
        expectedInvestor: INVESTOR,
        expectedBondId: 999, // Mismatched
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('does not match expected bondId');
    });

    it('rejects attestation when tranche does not match requested tranche', async () => {
      const attestation = await attestationService.issueAttestation({
        investorAddress: INVESTOR,
        bondId: 42,
        tranche: TrancheType.STANDARD,
        jurisdiction: 'US',
      });

      const result = attestationService.verifyAttestation(attestation, {
        expectedInvestor: INVESTOR,
        expectedBondId: 42,
        expectedTranche: TrancheType.RESTRICTED_ACCREDITED, // Expected restricted but attestation is for standard
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('does not match requested tranche');
    });

    it('rejects expired attestation', async () => {
      const attestation = await attestationService.issueAttestation({
        investorAddress: INVESTOR,
        bondId: 42,
        tranche: TrancheType.RESTRICTED_ACCREDITED,
        jurisdiction: 'US',
      });

      // Simulate expired payload
      attestation.payload.expiresAt = Math.floor(Date.now() / 1000) - 60;

      const result = attestationService.verifyAttestation(attestation, {
        expectedInvestor: INVESTOR,
        expectedBondId: 42,
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('expired');
    });

    it('rejects attestation with tampered payload or invalid signature', async () => {
      const attestation = await attestationService.issueAttestation({
        investorAddress: INVESTOR,
        bondId: 42,
        tranche: TrancheType.RESTRICTED_ACCREDITED,
        jurisdiction: 'US',
      });

      // Tamper with payload
      const tampered = {
        ...attestation,
        payload: {
          ...attestation.payload,
          investorAddress: OTHER_INVESTOR,
        },
      };

      const result = attestationService.verifyAttestation(tampered, {
        expectedInvestor: OTHER_INVESTOR,
        expectedBondId: 42,
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Cryptographic signature verification failed');
    });
  });
});
