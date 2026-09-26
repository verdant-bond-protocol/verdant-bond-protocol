import { Test, TestingModule } from '@nestjs/testing';
import { DomainInvariantsService } from './domain-invariants.service';
import { ReconciliationService } from './reconciliation.service';
import { RedisService } from '../../common/services/redis.service';
import { KycStoreService } from '../../common/services/kyc-store.service';
import { BondStatusEnum } from '../../bonds/interfaces/bond.interface';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';

describe('DomainInvariantsService (Disaster Recovery Validation #243)', () => {
  let service: DomainInvariantsService;
  let reconciliationService: ReconciliationService;
  let mockRedis: any;
  let mockKycStore: any;

  beforeEach(async () => {
    mockRedis = {
      scanKeys: jest.fn().mockResolvedValue([]),
      get: jest.fn().mockResolvedValue(null),
    };

    mockKycStore = {
      list: jest.fn().mockResolvedValue([]),
      listAudit: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DomainInvariantsService,
        ReconciliationService,
        { provide: RedisService, useValue: mockRedis },
        { provide: KycStoreService, useValue: mockKycStore },
      ],
    }).compile();

    service = module.get<DomainInvariantsService>(DomainInvariantsService);
    reconciliationService = module.get<ReconciliationService>(ReconciliationService);
    service.onModuleInit();
  });

  describe('Healthy baseline state', () => {
    it('returns zero drifts and HEALTHY status when all domain invariants hold', async () => {
      const context = {
        bonds: [
          { id: 1, projectId: 'proj-1', totalSupply: '1000', totalSubscribed: '500', status: BondStatusEnum.Active },
        ],
        projects: [
          { id: 'proj-1', name: 'Mangrove Restoration' },
        ],
        orders: [
          { id: 10, bondId: 1, amount: '100', status: 'Open', expiresAt: new Date(Date.now() + 100000).toISOString() },
        ],
        holdersByBond: {
          1: [{ address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', balance: '500' }],
        },
        settlementTransactions: [
          { txHash: 'a'.repeat(64), entityType: 'subscription', entityId: '1' },
        ],
        kycRecords: [
          { address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', status: KycStatus.VERIFIED, expiresAt: Date.now() + 100000 },
        ],
      };

      const report = await service.validateDomainInvariants(context);

      expect(report.status).toBe('HEALTHY');
      expect(report.driftsFound).toHaveLength(0);
      expect(report.dryRun).toBe(true);
      expect(report.summary.missingCount).toBe(0);
      expect(report.summary.orphanedCount).toBe(0);
      expect(report.summary.duplicateCount).toBe(0);
      expect(report.summary.inconsistentCount).toBe(0);
    });
  });

  describe('Missing & Orphaned records detection', () => {
    it('detects orphaned bond referencing non-existent project', async () => {
      const context = {
        bonds: [
          { id: 1, projectId: 'non-existent-proj', totalSupply: '1000', totalSubscribed: '0', status: BondStatusEnum.Active },
        ],
        projects: [
          { id: 'proj-1', name: 'Mangrove Restoration' },
        ],
      };

      const invariant = service.getBondProjectIntegrityInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'orphaned',
            entityType: 'bond',
            entityId: '1',
            affectedFields: ['projectId'],
          }),
        ]),
      );
    });

    it('detects missing project metadata', async () => {
      const context = {
        bonds: [],
        projects: [{ id: 'proj-1', name: '' }],
      };

      const invariant = service.getBondProjectIntegrityInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'missing',
            entityType: 'project',
            entityId: 'proj-1',
          }),
        ]),
      );
    });

    it('detects orphaned order referencing non-existent bond', async () => {
      const context = {
        bonds: [{ id: 1 }],
        orders: [{ id: 99, bondId: 999, amount: '50', status: 'Open' }],
      };

      const invariant = service.getMarketplaceOrderIntegrityInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'orphaned',
            entityType: 'order',
            entityId: '99',
            affectedFields: ['bondId'],
          }),
        ]),
      );
    });

    it('detects missing settlement transaction hash', async () => {
      const context = {
        settlementTransactions: [
          { txHash: '', entityType: 'subscription', entityId: 'sub-1' },
        ],
      };

      const invariant = service.getSettlementReferenceIntegrityInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'missing',
            entityType: 'subscription',
            entityId: 'sub-1',
          }),
        ]),
      );
    });
  });

  describe('Duplicate records detection', () => {
    it('detects duplicate bond IDs', async () => {
      const context = {
        bonds: [
          { id: 1, projectId: 'proj-1' },
          { id: 1, projectId: 'proj-1' },
        ],
        projects: [{ id: 'proj-1', name: 'Forest' }],
      };

      const invariant = service.getBondProjectIntegrityInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'duplicate',
            entityType: 'bond',
            entityId: '1',
          }),
        ]),
      );
    });

    it('detects duplicate holder entries on the same bond', async () => {
      const context = {
        bonds: [{ id: 1, totalSupply: '1000', totalSubscribed: '200', status: BondStatusEnum.Active }],
        holdersByBond: {
          1: [
            { address: 'ADDR1', balance: '100' },
            { address: 'ADDR1', balance: '100' },
          ],
        },
      };

      const invariant = service.getBondSupplyAccountingInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'duplicate',
            entityType: 'holder',
            entityId: '1:ADDR1',
          }),
        ]),
      );
    });

    it('detects duplicate transaction hash collision across distinct entities', async () => {
      const sharedHash = 'b'.repeat(64);
      const context = {
        settlementTransactions: [
          { txHash: sharedHash, entityType: 'subscription', entityId: 'sub-1' },
          { txHash: sharedHash, entityType: 'order_fill', entityId: 'ord-2' },
        ],
      };

      const invariant = service.getSettlementReferenceIntegrityInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'duplicate',
            entityType: 'settlement_reference',
            entityId: sharedHash,
            severity: 'CRITICAL',
          }),
        ]),
      );
    });

    it('detects duplicate KYC records for the same wallet address', async () => {
      const context = {
        kycRecords: [
          { address: 'ADDR1', status: KycStatus.VERIFIED },
          { address: 'ADDR1', status: KycStatus.VERIFIED },
        ],
      };

      const invariant = service.getKycComplianceIntegrityInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'duplicate',
            entityType: 'kyc_record',
            entityId: 'ADDR1',
          }),
        ]),
      );
    });
  });

  describe('Inconsistent records detection', () => {
    it('detects totalSubscribed exceeding totalSupply', async () => {
      const context = {
        bonds: [
          { id: 1, totalSupply: '500', totalSubscribed: '600', status: BondStatusEnum.Active },
        ],
        holdersByBond: { 1: [{ address: 'A', balance: '600' }] },
      };

      const invariant = service.getBondSupplyAccountingInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'inconsistent',
            severity: 'CRITICAL',
            entityType: 'bond',
            entityId: '1',
            affectedFields: expect.arrayContaining(['totalSubscribed', 'totalSupply']),
          }),
        ]),
      );
    });

    it('detects sum of holder balances differing from totalSubscribed', async () => {
      const context = {
        bonds: [
          { id: 1, totalSupply: '1000', totalSubscribed: '500', status: BondStatusEnum.Active },
        ],
        holdersByBond: { 1: [{ address: 'A', balance: '400' }] }, // sum is 400, expected 500
      };

      const invariant = service.getBondSupplyAccountingInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'inconsistent',
            severity: 'CRITICAL',
            description: expect.stringContaining('holder balance sum (400) does not match recorded totalSubscribed (500)'),
          }),
        ]),
      );
    });

    it('detects negative holder balance', async () => {
      const context = {
        bonds: [
          { id: 1, totalSupply: '1000', totalSubscribed: '0', status: BondStatusEnum.Active },
        ],
        holdersByBond: { 1: [{ address: 'A', balance: '-50' }] },
      };

      const invariant = service.getBondSupplyAccountingInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'inconsistent',
            severity: 'CRITICAL',
            entityType: 'holder',
            entityId: '1:A',
          }),
        ]),
      );
    });

    it('detects malformed Stellar transaction hash', async () => {
      const context = {
        settlementTransactions: [
          { txHash: 'not-a-valid-hex-hash', entityType: 'transfer', entityId: 'tx-1' },
        ],
      };

      const invariant = service.getSettlementReferenceIntegrityInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'inconsistent',
            severity: 'CRITICAL',
            entityType: 'transfer',
            entityId: 'tx-1',
          }),
        ]),
      );
    });

    it('detects non-monotonic KYC audit trail timestamps', async () => {
      mockKycStore.listAudit = jest.fn().mockResolvedValue([
        { id: '1', timestamp: 2000, toStatus: KycStatus.PENDING },
        { id: '2', timestamp: 1000, toStatus: KycStatus.VERIFIED }, // earlier timestamp than previous!
      ]);

      const context = {
        kycRecords: [{ address: 'ADDR1', status: KycStatus.VERIFIED }],
      };

      const invariant = service.getKycComplianceIntegrityInvariant();
      const drifts = await invariant.check(context);

      expect(drifts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'inconsistent',
            entityType: 'kyc_audit',
            entityId: 'ADDR1',
          }),
        ]),
      );
    });
  });

  describe('ReconciliationService integration & dry-run reporting', () => {
    it('registers invariants onModuleInit and runs dry-run through ReconciliationService', async () => {
      expect(reconciliationService.getInvariantCount()).toBe(5);

      const report = await reconciliationService.runDryRun();
      expect(report.dryRun).toBe(true);
      expect(report.timestamp).toBeInstanceOf(Date);
      expect(report.status).toBeDefined();
    });
  });
});
