import { BadRequestException } from '@nestjs/common';
import { DeduplicationController } from './deduplication.controller';
import { DeduplicationService } from './deduplication.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CandidateStatus, EntityType, MergeStatus } from './deduplication.types';

const GUARDS_METADATA = '__guards__';

describe('DeduplicationController', () => {
  let controller: DeduplicationController;
  let mockService: Partial<DeduplicationService>;

  beforeEach(() => {
    mockService = {
      scan: jest.fn(async (opts) => ({
        entityType: opts.entityType,
        scannedCount: 10,
        candidatesFound: 2,
        candidates: [],
        scanFingerprint: 'mock-fp',
        scannedAt: '2026-10-18T20:00:00Z',
      })),
      listCandidates: jest.fn(async () => ({
        data: [],
        total: 0,
        offset: 0,
        limit: 50,
      })),
      getCandidate: jest.fn(async (id) => ({
        id,
        entityType: EntityType.KYC_RECORD,
        primaryId: 'addrA',
        secondaryId: 'addrB',
        confidenceScore: 0.95,
        evaluations: [],
        status: CandidateStatus.PENDING_REVIEW,
        detectedAt: '2026-10-18T20:00:00Z',
        primarySnapshot: {},
        secondarySnapshot: {},
        primaryDigest: 'd1',
        secondaryDigest: 'd2',
        diffs: [],
      })),
      reviewCandidate: jest.fn(async (id, dto) => ({
        id,
        entityType: EntityType.KYC_RECORD,
        primaryId: 'addrA',
        secondaryId: 'addrB',
        confidenceScore: 0.95,
        evaluations: [],
        status: dto.decision as any,
        detectedAt: '2026-10-18T20:00:00Z',
        primarySnapshot: {},
        secondarySnapshot: {},
        primaryDigest: 'd1',
        secondaryDigest: 'd2',
        diffs: [],
        review: {
          reviewer: dto.reviewer,
          decision: dto.decision,
          reason: dto.reason,
          reviewedAt: '2026-10-18T20:00:00Z',
        },
      })),
      executeMerge: jest.fn(async (id, actor, reason) => ({
        id: 'merge-1',
        candidateId: id,
        entityType: EntityType.KYC_RECORD,
        primaryId: 'addrA',
        secondaryId: 'addrB',
        preMergePrimary: {},
        preMergeSecondary: {},
        postMergePrimary: {},
        postMergeSecondary: {},
        appliedStrategies: {},
        executedBy: actor,
        executedAt: '2026-10-18T20:00:00Z',
        status: MergeStatus.MERGED,
        stateDigest: 'digest-1',
      })),
      reverseMerge: jest.fn(async (id, actor, reason) => ({
        id,
        candidateId: 'cand-1',
        entityType: EntityType.KYC_RECORD,
        primaryId: 'addrA',
        secondaryId: 'addrB',
        preMergePrimary: {},
        preMergeSecondary: {},
        postMergePrimary: {},
        postMergeSecondary: {},
        appliedStrategies: {},
        executedBy: 'admin',
        executedAt: '2026-10-18T20:00:00Z',
        status: MergeStatus.REVERSED,
        reversedBy: actor,
        reversedAt: '2026-10-18T20:05:00Z',
        reversalReason: reason,
        stateDigest: 'digest-1',
      })),
      getMerge: jest.fn(async (id) => ({
        id,
        candidateId: 'cand-1',
        entityType: EntityType.KYC_RECORD,
        primaryId: 'addrA',
        secondaryId: 'addrB',
        preMergePrimary: {},
        preMergeSecondary: {},
        postMergePrimary: {},
        postMergeSecondary: {},
        appliedStrategies: {},
        executedBy: 'admin',
        executedAt: '2026-10-18T20:00:00Z',
        status: MergeStatus.MERGED,
        stateDigest: 'digest-1',
      })),
      listMerges: jest.fn(async () => []),
    };

    controller = new DeduplicationController(mockService as DeduplicationService);
  });

  it('declares JwtAuthGuard and AdminGuard at the controller level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, DeduplicationController);
    expect(guards).toEqual([JwtAuthGuard, AdminGuard]);
  });

  describe('scan endpoint', () => {
    it('requires entityType', async () => {
      await expect(controller.scan({} as any)).rejects.toThrow(BadRequestException);
    });

    it('delegates valid scan options to service', async () => {
      const res = await controller.scan({ entityType: EntityType.KYC_RECORD, minConfidence: 0.7 });
      expect(mockService.scan).toHaveBeenCalledWith({
        entityType: EntityType.KYC_RECORD,
        minConfidence: 0.7,
      });
      expect(res.scanFingerprint).toBe('mock-fp');
    });
  });

  describe('candidates endpoints', () => {
    it('lists candidates with parsed filter params', async () => {
      await controller.listCandidates(EntityType.KYC_RECORD, CandidateStatus.PENDING_REVIEW, '0.8', '10', '20');
      expect(mockService.listCandidates).toHaveBeenCalledWith({
        entityType: EntityType.KYC_RECORD,
        status: CandidateStatus.PENDING_REVIEW,
        minConfidence: 0.8,
        offset: 10,
        limit: 20,
      });
    });

    it('gets a candidate by ID', async () => {
      const res = await controller.getCandidate('cand-123');
      expect(mockService.getCandidate).toHaveBeenCalledWith('cand-123');
      expect(res.id).toBe('cand-123');
    });

    it('validates review input and sets reviewer from request', async () => {
      const mockReq = { user: { walletAddress: 'wallet_reviewer_1' } } as any;
      await expect(
        controller.reviewCandidate('cand-1', { decision: 'approved', reason: '' }, mockReq),
      ).rejects.toThrow(BadRequestException);

      const res = await controller.reviewCandidate(
        'cand-1',
        { decision: 'approved', reason: 'Verified match' },
        mockReq,
      );
      expect(mockService.reviewCandidate).toHaveBeenCalledWith('cand-1', {
        reviewer: 'wallet_reviewer_1',
        decision: 'approved',
        reason: 'Verified match',
        fieldStrategies: undefined,
      });
      expect(res.status).toBe('approved');
    });

    it('executes merge with actor from request', async () => {
      const mockReq = { user: { walletAddress: 'wallet_operator_1' } } as any;
      const res = await controller.executeMerge('cand-1', { reason: 'Merge confirmed' }, mockReq);
      expect(mockService.executeMerge).toHaveBeenCalledWith('cand-1', 'wallet_operator_1', 'Merge confirmed');
      expect(res.id).toBe('merge-1');
    });
  });

  describe('merges endpoints', () => {
    it('gets merge by ID and lists merges', async () => {
      await controller.getMerge('merge-1');
      expect(mockService.getMerge).toHaveBeenCalledWith('merge-1');

      await controller.listMerges();
      expect(mockService.listMerges).toHaveBeenCalled();
    });

    it('reverses merge with mandatory reason and actor from request', async () => {
      const mockReq = { user: { walletAddress: 'wallet_commander_1' } } as any;
      await expect(controller.reverseMerge('merge-1', { reason: '' }, mockReq)).rejects.toThrow(
        BadRequestException,
      );

      const res = await controller.reverseMerge(
        'merge-1',
        { reason: 'Accounts distinct after further documentation' },
        mockReq,
      );
      expect(mockService.reverseMerge).toHaveBeenCalledWith(
        'merge-1',
        'wallet_commander_1',
        'Accounts distinct after further documentation',
      );
      expect(res.status).toBe(MergeStatus.REVERSED);
    });
  });
});
