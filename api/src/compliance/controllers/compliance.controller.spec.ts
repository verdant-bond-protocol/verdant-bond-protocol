import { Test } from '@nestjs/testing';
import { ComplianceController } from './compliance.controller';
import { ComplianceRulesEngine } from '../services/compliance-rules.engine';
import { ComplianceAttestationService } from '../services/compliance-attestation.service';
import { SanctionsService } from '../services/sanctions.service';
import { KycStoreService } from '../../common/services/kyc-store.service';
import { TrancheType } from '../interfaces/compliance.interface';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';

describe('ComplianceController', () => {
  let controller: ComplianceController;
  let rulesEngine: ComplianceRulesEngine;
  let attestationService: ComplianceAttestationService;
  let sanctionsService: SanctionsService;

  const WALLET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  beforeEach(async () => {
    sanctionsService = new SanctionsService();
    rulesEngine = new ComplianceRulesEngine(sanctionsService);

    const mockKycStore = {
      get: jest.fn().mockResolvedValue({
        walletAddress: WALLET,
        status: KycStatus.ACCREDITED,
        source: 'test',
        updatedAt: Date.now(),
      }),
    };

    attestationService = new ComplianceAttestationService(
      rulesEngine,
      mockKycStore as any,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [ComplianceController],
      providers: [
        { provide: ComplianceRulesEngine, useValue: rulesEngine },
        { provide: ComplianceAttestationService, useValue: attestationService },
        { provide: SanctionsService, useValue: sanctionsService },
        { provide: KycStoreService, useValue: mockKycStore },
      ],
    }).compile();

    controller = moduleRef.get(ComplianceController);
  });

  it('GET /ruleset returns canonical versioned ruleset and audit hash', () => {
    const ruleset = controller.getRuleset();
    expect(ruleset).toBeDefined();
    expect(ruleset.version).toBe('2026.1');
    expect(ruleset.auditHash).toBeDefined();
  });

  it('POST /evaluate evaluates investor eligibility against current ruleset', async () => {
    const decision = await controller.evaluate({
      investorAddress: WALLET,
      bondId: 10,
      tranche: TrancheType.RESTRICTED_ACCREDITED,
      jurisdiction: 'US',
    });

    expect(decision.eligible).toBe(true);
    expect(decision.code).toBe('ELIGIBLE');
  });

  it('POST /attestation issues a signed attestation for authenticated wallet', async () => {
    const req = {
      user: {
        walletAddress: WALLET,
        role: 'user',
        kycStatus: KycStatus.ACCREDITED,
      },
    };

    const attestation = await controller.issueAttestation(
      {
        bondId: 10,
        tranche: TrancheType.RESTRICTED_ACCREDITED,
        jurisdiction: 'US',
      },
      req,
    );

    expect(attestation).toBeDefined();
    expect(attestation.signature).toBeDefined();
    expect(attestation.payload.investorAddress).toBe(WALLET);
    expect(attestation.payload.bondId).toBe(10);
  });

  it('GET /sanctions/status returns sanctions refresh status and cadence', () => {
    const status = controller.getSanctionsStatus();
    expect(status.refreshCadence).toBe('0 0 * * *');
    expect(status.isStale).toBe(false);
  });

  it('POST /sanctions/refresh triggers refresh and returns updated status', async () => {
    const status = await controller.refreshSanctions({
      additionalAddresses: ['GNEWSANCTION12345'],
    });

    expect(status.isStale).toBe(false);
    expect(sanctionsService.isSanctioned('GNEWSANCTION12345')).toBe(true);
  });
});
