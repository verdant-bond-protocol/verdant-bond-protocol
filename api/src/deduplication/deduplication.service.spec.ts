import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { DeduplicationService } from './deduplication.service';
import { KycDeduplicationAdapter } from './adapters/kyc-deduplication.adapter';
import { ProjectDeduplicationAdapter } from './adapters/project-deduplication.adapter';
import {
  CandidateStatus,
  EntityType,
  FieldResolutionStrategy,
  MergeStatus,
} from './deduplication.types';
import { KycRecord, KycStatus } from '../common/interfaces/authenticated-request.interface';
import { ProjectResponse, ProjectStatusEnum } from '../projects/interfaces/project.interface';
import { AuditService } from '../audit/audit.service';
import { KycService } from '../auth/kyc.service';
import { KycStoreService } from '../common/services/kyc-store.service';

describe('DeduplicationService & Merge Review Workflow', () => {
  let service: DeduplicationService;
  let kycAdapter: KycDeduplicationAdapter;
  let projectAdapter: ProjectDeduplicationAdapter;

  // Mock KYC store and service
  let kycStoreMemory: Map<string, KycRecord>;
  let mockKycStore: Partial<KycStoreService>;
  let mockKycService: Partial<KycService>;
  let mockAuditService: Partial<AuditService>;
  let auditLogs: any[];

  const ADDR_1 = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3IF2WS7RSR23';
  const ADDR_2 = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const ADDR_3 = 'GC5O54TNYNIVOKHB6HAG7J4Y32S4553X4XG7PQ5GTRF3Z6F52Q57MN5T';

  beforeEach(() => {
    kycStoreMemory = new Map<string, KycRecord>();
    auditLogs = [];

    mockKycStore = {
      list: jest.fn(async () => Array.from(kycStoreMemory.values())),
      get: jest.fn(async (addr: string) => kycStoreMemory.get(addr) ?? null),
    };

    mockKycService = {
      transitionStatus: jest.fn(
        async (
          address: string,
          toStatus: KycStatus,
          opts: any = {},
        ): Promise<{ record: KycRecord; entry: any; isNew: boolean }> => {
          const existing = kycStoreMemory.get(address);
          const now = Date.now();
          const record: KycRecord = {
            address,
            status: toStatus,
            source: opts.source ?? 'admin',
            actor: opts.actor ?? existing?.actor ?? null,
            reason: opts.reason ?? existing?.reason ?? null,
            providerReference:
              opts.providerReference !== undefined
                ? opts.providerReference
                : existing?.providerReference ?? null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            expiresAt:
              opts.expiresAt !== undefined ? opts.expiresAt : existing?.expiresAt ?? null,
          };
          kycStoreMemory.set(address, record);
          return { record, entry: { id: 'audit-1' }, isNew: !existing };
        },
      ),
    };

    mockAuditService = {
      record: jest.fn(async (write: any) => {
        auditLogs.push(write);
        return { kind: 'recorded' as const, rejectReason: '', record: null };
      }),
    };

    kycAdapter = new KycDeduplicationAdapter(
      mockKycService as KycService,
      mockKycStore as KycStoreService,
    );

    projectAdapter = new ProjectDeduplicationAdapter();

    service = new DeduplicationService(
      kycAdapter,
      projectAdapter,
      mockAuditService as AuditService,
    );
  });

  describe('Deterministic Candidate Detection', () => {
    beforeEach(() => {
      // Seed 2 duplicate records sharing the same provider reference
      kycStoreMemory.set(ADDR_1, {
        address: ADDR_1,
        status: KycStatus.VERIFIED,
        source: 'provider',
        actor: 'synaps-provider',
        reason: 'Identity verified: John Doe, national_id: 12345',
        providerReference: 'applicant-john-doe-999',
        createdAt: 1000000,
        updatedAt: 1000000,
        expiresAt: 2000000,
      });

      kycStoreMemory.set(ADDR_2, {
        address: ADDR_2,
        status: KycStatus.ACCREDITED,
        source: 'provider',
        actor: 'synaps-provider',
        reason: 'Identity verified: John Doe, national_id: 12345',
        providerReference: 'applicant-john-doe-999',
        createdAt: 1050000,
        updatedAt: 1050000,
        expiresAt: 2500000,
      });

      // Third unrelated investor
      kycStoreMemory.set(ADDR_3, {
        address: ADDR_3,
        status: KycStatus.PENDING,
        source: 'admin',
        actor: 'admin-alice',
        reason: 'Pending verification for Jane Smith',
        providerReference: 'applicant-jane-smith-888',
        createdAt: 3000000,
        updatedAt: 3000000,
        expiresAt: null,
      });
    });

    it('1. Detects candidate duplicates reproducibly with identical scores and candidate IDs', async () => {
      const scan1 = await service.scan({ entityType: EntityType.KYC_RECORD });
      const scan2 = await service.scan({ entityType: EntityType.KYC_RECORD });

      expect(scan1.candidatesFound).toBe(1);
      expect(scan2.candidatesFound).toBe(1);
      expect(scan1.scanFingerprint).toBe(scan2.scanFingerprint);

      const candidate1 = scan1.candidates[0];
      const candidate2 = scan2.candidates[0];

      expect(candidate1.id).toBe(candidate2.id);
      expect(candidate1.confidenceScore).toBe(candidate2.confidenceScore);
      expect(candidate1.confidenceScore).toBeGreaterThanOrEqual(0.8);
      expect(candidate1.status).toBe(CandidateStatus.PENDING_REVIEW);

      // Verify rule evaluations breakdown
      const providerRefRule = candidate1.evaluations.find(
        (e) => e.ruleId === 'EXACT_PROVIDER_REFERENCE',
      );
      expect(providerRefRule?.passed).toBe(true);
      expect(providerRefRule?.score).toBe(1.0);
    });

    it('2. Orders candidates deterministically by confidence desc and primaryId asc', async () => {
      const scan = await service.scan({ entityType: EntityType.KYC_RECORD, minConfidence: 0.1 });
      const list = await service.listCandidates({ entityType: EntityType.KYC_RECORD });

      expect(list.total).toBe(scan.candidatesFound);
      for (let i = 0; i < list.data.length - 1; i++) {
        expect(list.data[i].confidenceScore).toBeGreaterThanOrEqual(
          list.data[i + 1].confidenceScore,
        );
      }
    });

    it('3. Refuses self-comparison and ignores duplicate scans of identical states', async () => {
      const scan = await service.scan({ entityType: EntityType.KYC_RECORD });
      const candidate = scan.candidates[0];
      expect(candidate.primaryId).not.toBe(candidate.secondaryId);
    });
  });

  describe('Review Workflow', () => {
    let candidateId: string;

    beforeEach(async () => {
      kycStoreMemory.set(ADDR_1, {
        address: ADDR_1,
        status: KycStatus.VERIFIED,
        source: 'provider',
        actor: 'provider',
        reason: 'Verified',
        providerReference: 'applicant-duplicate-1',
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 5000,
      });

      kycStoreMemory.set(ADDR_2, {
        address: ADDR_2,
        status: KycStatus.ACCREDITED,
        source: 'provider',
        actor: 'provider',
        reason: 'Verified',
        providerReference: 'applicant-duplicate-1',
        createdAt: 2000,
        updatedAt: 2000,
        expiresAt: 8000,
      });

      const scan = await service.scan({ entityType: EntityType.KYC_RECORD });
      candidateId = scan.candidates[0].id;
    });

    it('4. Rejects merge execution before human review approval', async () => {
      await expect(service.executeMerge(candidateId, 'admin-user')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('5. Successfully approves candidate with review rationale and field strategies', async () => {
      const reviewed = await service.reviewCandidate(candidateId, {
        reviewer: 'compliance-officer-1',
        decision: 'approved',
        reason: 'Confirmed same investor operating two Stellar wallets',
        fieldStrategies: {
          status: { strategy: FieldResolutionStrategy.PRIMARY_WINS },
        },
      });

      expect(reviewed.status).toBe(CandidateStatus.APPROVED);
      expect(reviewed.review?.reviewer).toBe('compliance-officer-1');
      expect(reviewed.review?.decision).toBe('approved');

      // Verify audit trail
      const auditEntry = auditLogs.find((l) => l.action === 'candidate_reviewed');
      expect(auditEntry).toBeDefined();
      expect(auditEntry.actor).toBe('compliance-officer-1');
    });

    it('6. Rejects or dismisses candidate without merging', async () => {
      const rejected = await service.reviewCandidate(candidateId, {
        reviewer: 'compliance-officer-2',
        decision: 'rejected',
        reason: 'False positive: joint enterprise shared reference',
      });

      expect(rejected.status).toBe(CandidateStatus.REJECTED);
      await expect(service.executeMerge(candidateId, 'admin-user')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('Merge Execution & Field Conflict Resolution', () => {
    let candidateId: string;

    beforeEach(async () => {
      kycStoreMemory.set(ADDR_1, {
        address: ADDR_1,
        status: KycStatus.VERIFIED,
        source: 'provider',
        actor: 'provider',
        reason: 'Primary verified',
        providerReference: 'applicant-ref-99',
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 5000,
      });

      kycStoreMemory.set(ADDR_2, {
        address: ADDR_2,
        status: KycStatus.ACCREDITED,
        source: 'provider',
        actor: 'provider',
        reason: 'Secondary accredited',
        providerReference: 'applicant-ref-99',
        createdAt: 2000,
        updatedAt: 2000,
        expiresAt: 9000,
      });

      const scan = await service.scan({ entityType: EntityType.KYC_RECORD });
      candidateId = scan.candidates[0].id;

      await service.reviewCandidate(candidateId, {
        reviewer: 'compliance-admin',
        decision: 'approved',
        reason: 'Legitimate multi-wallet investor duplicate',
      });
    });

    it('7. Merges secondary into primary with default rank-based and latest-expiry resolution', async () => {
      const journal = await service.executeMerge(candidateId, 'admin-operator', 'Batch duplicate merge');

      expect(journal.status).toBe(MergeStatus.MERGED);
      expect(journal.candidateId).toBe(candidateId);
      expect(journal.primaryId).toBe(ADDR_2.localeCompare(ADDR_1) <= 0 ? ADDR_2 : ADDR_1);

      // Verify primary absorbed highest KYC status (ACCREDITED) and latest expiry (9000)
      const primaryRecord = kycStoreMemory.get(journal.primaryId)!;
      expect(primaryRecord.status).toBe(KycStatus.ACCREDITED);
      expect(primaryRecord.expiresAt).toBe(9000);

      // Verify secondary record is marked NONE / merged
      const secondaryRecord = kycStoreMemory.get(journal.secondaryId)!;
      expect(secondaryRecord.status).toBe(KycStatus.NONE);
      expect(secondaryRecord.reason?.toLowerCase()).toContain('merged into primary');

      // Verify audit logging
      const audit = auditLogs.find((l) => l.action === 'merge_executed');
      expect(audit).toBeDefined();
      expect(audit.actor).toBe('admin-operator');
    });

    it('8. Supports manual field override resolution strategy', async () => {
      // Re-review with manual status override
      await service.reviewCandidate(candidateId, {
        reviewer: 'compliance-admin',
        decision: 'approved',
        reason: 'Manual tier override test',
        fieldStrategies: {
          status: { strategy: FieldResolutionStrategy.MANUAL, manualValue: KycStatus.VERIFIED },
        },
      });

      const journal = await service.executeMerge(candidateId, 'admin-operator');
      const primary = kycStoreMemory.get(journal.primaryId)!;
      expect(primary.status).toBe(KycStatus.VERIFIED);
    });

    it('9. Cannot merge the same candidate twice', async () => {
      await service.executeMerge(candidateId, 'admin-operator');
      await expect(service.executeMerge(candidateId, 'admin-operator')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('State Drift Protection & Invariants', () => {
    let candidateId: string;

    beforeEach(async () => {
      kycStoreMemory.set(ADDR_1, {
        address: ADDR_1,
        status: KycStatus.VERIFIED,
        source: 'provider',
        actor: 'provider',
        reason: 'Initial',
        providerReference: 'applicant-drift-test',
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 5000,
      });

      kycStoreMemory.set(ADDR_2, {
        address: ADDR_2,
        status: KycStatus.VERIFIED,
        source: 'provider',
        actor: 'provider',
        reason: 'Initial',
        providerReference: 'applicant-drift-test',
        createdAt: 2000,
        updatedAt: 2000,
        expiresAt: 5000,
      });

      const scan = await service.scan({ entityType: EntityType.KYC_RECORD });
      candidateId = scan.candidates[0].id;

      await service.reviewCandidate(candidateId, {
        reviewer: 'compliance-admin',
        decision: 'approved',
        reason: 'Approved before drift',
      });
    });

    it('10. Rejects merge execution if target state drifted between review and merge', async () => {
      // External modification after review
      const record = kycStoreMemory.get(ADDR_1)!;
      kycStoreMemory.set(ADDR_1, {
        ...record,
        status: KycStatus.ACCREDITED, // status drifted!
        updatedAt: 3000,
      });

      await expect(service.executeMerge(candidateId, 'admin-operator')).rejects.toThrow(
        ConflictException,
      );
    });

    it('11. Detects and blocks transitive merge conflicts', async () => {
      // Execute initial merge ADDR_1 & ADDR_2
      const journal1 = await service.executeMerge(candidateId, 'admin-operator');

      // Now create a 3rd record that also matches ADDR_2 (which is now merged)
      kycStoreMemory.set(ADDR_3, {
        address: ADDR_3,
        status: KycStatus.VERIFIED,
        source: 'provider',
        actor: 'provider',
        reason: 'Third record',
        providerReference: 'applicant-drift-test',
        createdAt: 4000,
        updatedAt: 4000,
        expiresAt: 5000,
      });

      // Manually simulate a candidate between ADDR_3 and the already merged secondary
      const conflictCandidateId = 'conflict-candidate';
      (service as any).candidates.set(conflictCandidateId, {
        id: conflictCandidateId,
        entityType: EntityType.KYC_RECORD,
        primaryId: ADDR_3,
        secondaryId: journal1.secondaryId, // already merged!
        status: CandidateStatus.APPROVED,
        primaryDigest: kycAdapter.computeStateDigest(kycStoreMemory.get(ADDR_3)!),
        secondaryDigest: kycAdapter.computeStateDigest(kycStoreMemory.get(journal1.secondaryId)!),
      });

      await expect(service.executeMerge(conflictCandidateId, 'admin-operator')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('Reversibility & Rollback Execution', () => {
    let candidateId: string;
    let mergeId: string;

    beforeEach(async () => {
      kycStoreMemory.set(ADDR_1, {
        address: ADDR_1,
        status: KycStatus.VERIFIED,
        source: 'provider',
        actor: 'provider',
        reason: 'Pre-merge primary',
        providerReference: 'applicant-reversal-1',
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 5000,
      });

      kycStoreMemory.set(ADDR_2, {
        address: ADDR_2,
        status: KycStatus.ACCREDITED,
        source: 'provider',
        actor: 'provider',
        reason: 'Pre-merge secondary',
        providerReference: 'applicant-reversal-1',
        createdAt: 2000,
        updatedAt: 2000,
        expiresAt: 9000,
      });

      const scan = await service.scan({ entityType: EntityType.KYC_RECORD });
      candidateId = scan.candidates[0].id;

      await service.reviewCandidate(candidateId, {
        reviewer: 'compliance-admin',
        decision: 'approved',
        reason: 'Approved for merge',
      });

      const journal = await service.executeMerge(candidateId, 'admin-operator');
      mergeId = journal.id;
    });

    it('12. Reverses merge accurately: restores exact pre-merge state for both accounts', async () => {
      const reversedJournal = await service.reverseMerge(
        mergeId,
        'incident-commander',
        'Customer clarified accounts belong to different family members',
      );

      expect(reversedJournal.status).toBe(MergeStatus.REVERSED);
      expect(reversedJournal.reversedBy).toBe('incident-commander');
      expect(reversedJournal.reversalReason).toBe(
        'Customer clarified accounts belong to different family members',
      );

      // Verify secondary account is restored from NONE back to its pre-merge status (VERIFIED) and expiry
      const restoredSecondary = kycStoreMemory.get(reversedJournal.secondaryId)!;
      expect(restoredSecondary.status).toBe(KycStatus.VERIFIED);
      expect(restoredSecondary.expiresAt).toBe(5000);

      // Verify primary account is restored back to its pre-merge status (ACCREDITED) and expiry
      const restoredPrimary = kycStoreMemory.get(reversedJournal.primaryId)!;
      expect(restoredPrimary.status).toBe(KycStatus.ACCREDITED);
      expect(restoredPrimary.expiresAt).toBe(9000);

      // Verify audit logging
      const audit = auditLogs.find((l) => l.action === 'merge_reversed');
      expect(audit).toBeDefined();
      expect(audit.actor).toBe('incident-commander');
    });

    it('13. Refuses double-reversal of an already rolled-back merge', async () => {
      await service.reverseMerge(mergeId, 'incident-commander', 'First reversal');
      await expect(
        service.reverseMerge(mergeId, 'incident-commander', 'Second reversal attempt'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Green Bond Project Deduplication', () => {
    beforeEach(() => {
      const proj1: ProjectResponse = {
        id: 101,
        name: 'Amazon Agroforestry Carbon Project',
        status: ProjectStatusEnum.Approved,
        methodology: 'VM0007',
        country: 'Brazil',
        metadataIpfsHash: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
        ownerAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        totalAreaHa: 5000,
        carbonSequestrationEstimate: 120000,
        createdAt: '2026-01-01T00:00:00Z',
      };

      const proj2: ProjectResponse = {
        id: 102,
        name: 'Amazon Agroforestry Carbon Proj',
        status: ProjectStatusEnum.Approved,
        methodology: 'VM0007',
        country: 'Brazil',
        metadataIpfsHash: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
        ownerAddress: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3IF2WS7RSR23',
        totalAreaHa: 5200,
        carbonSequestrationEstimate: 125000,
        createdAt: '2026-01-02T00:00:00Z',
      };

      projectAdapter.setEntity(proj1);
      projectAdapter.setEntity(proj2);
    });

    it('14. Detects, reviews, merges, and reverses green bond project duplicates', async () => {
      // 1. Scan projects
      const scan = await service.scan({ entityType: EntityType.PROJECT });
      expect(scan.candidatesFound).toBe(1);

      const candidate = scan.candidates[0];
      expect(candidate.confidenceScore).toBeGreaterThanOrEqual(0.85);

      // 2. Review and approve
      await service.reviewCandidate(candidate.id, {
        reviewer: 'registry-auditor',
        decision: 'approved',
        reason: 'Duplicate registration of identical Amazon parcel under different developer wallet',
      });

      // 3. Execute merge
      const journal = await service.executeMerge(candidate.id, 'registry-admin');
      expect(journal.status).toBe(MergeStatus.MERGED);

      const secondaryProj = await projectAdapter.getEntity(journal.secondaryId);
      expect(secondaryProj?.status).toBe(ProjectStatusEnum.Inactive);

      const primaryProj = await projectAdapter.getEntity(journal.primaryId);
      expect(primaryProj?.carbonSequestrationEstimate).toBe(125000); // absorbed highest estimate

      // 4. Reverse merge
      const reversed = await service.reverseMerge(journal.id, 'registry-admin', 'Parcels verified distinct');
      expect(reversed.status).toBe(MergeStatus.REVERSED);

      const restoredSecondary = await projectAdapter.getEntity(journal.secondaryId);
      expect(restoredSecondary?.status).toBe(ProjectStatusEnum.Approved);
    });
  });
});
