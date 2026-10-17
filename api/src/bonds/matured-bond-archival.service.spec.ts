import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  MaturedBondArchivalService,
  ArchiveBondDto,
} from './matured-bond-archival.service';
import { BondsService } from './bonds.service';
import { HolderIndexService } from './holder-index.service';
import {
  BondResponse,
  BondStatusEnum,
  BondMaturityStatusEnum,
  CreditTypeEnum,
} from './interfaces/bond.interface';
import { ArchiveState } from '../common/lifecycle/record-lifecycle';

describe('MaturedBondArchivalService (#472)', () => {
  let service: MaturedBondArchivalService;
  let bondsServiceMock: Partial<BondsService>;
  let holderIndexServiceMock: Partial<HolderIndexService>;

  const maturedMockBond: BondResponse = {
    id: 1,
    projectId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    faceValue: '1000',
    couponSchedule: ['1000', '2000'],
    creditType: CreditTypeEnum.Carbon,
    maturityDate: Math.floor(Date.now() / 1000) - 86400, // past maturity
    maturityStatus: BondMaturityStatusEnum.Matured,
    totalSupply: '10000',
    totalSubscribed: '10000',
    status: BondStatusEnum.Matured,
    createdAt: '2025-01-01T00:00:00.000Z',
  };

  const activeMockBond: BondResponse = {
    ...maturedMockBond,
    id: 2,
    maturityDate: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days in future
    maturityStatus: BondMaturityStatusEnum.Active,
    status: BondStatusEnum.Active,
  };

  beforeEach(() => {
    bondsServiceMock = {
      findOne: jest.fn().mockImplementation(async (id: number) => {
        if (id === 1) return { ...maturedMockBond };
        if (id === 2) return { ...activeMockBond };
        throw new NotFoundException(`Bond ${id} not found`);
      }),
    };

    holderIndexServiceMock = {
      getAuthoritativeHolders: jest.fn().mockResolvedValue(['GBHOLDER1', 'GBHOLDER2']),
    };

    service = new MaturedBondArchivalService(
      bondsServiceMock as BondsService,
      holderIndexServiceMock as HolderIndexService,
    );
  });

  describe('Normal Archival & Restore Path', () => {
    it('archives a matured bond with full attribution and reason', async () => {
      const dto: ArchiveBondDto = {
        reason: 'Bond matured, all redemptions processed and verified',
        actor: 'GADMIN123',
      };

      const result = await service.archiveMaturedRecord(1, dto);

      expect(result.status).toBe('Archived');
      expect(result.archivedBy).toBe('GADMIN123');
      expect(result.archiveReason).toBe(dto.reason);
      expect(result.lifecycle.state).toBe(ArchiveState.Archived);
      expect(result.lifecycle.history).toHaveLength(1);
      expect(result.lifecycle.history[0].action).toBe('archive');

      const isArchived = await service.isBondArchived(1);
      expect(isArchived).toBe(true);
    });

    it('successfully verifies and restores an archived matured bond', async () => {
      await service.archiveMaturedRecord(1, {
        reason: 'Archived for testing restore',
        actor: 'GADMIN123',
      });

      // 1. Verify restore preview
      const verification = await service.verifyRestore(1);
      expect(verification.status).toBe('VERIFIED');
      expect(verification.mismatches).toHaveLength(0);
      expect(verification.checks.integrity.passed).toBe(true);
      expect(verification.checks.invariants.passed).toBe(true);
      expect(verification.checks.provenance.passed).toBe(true);
      expect(verification.checks.derivedIndex.passed).toBe(true);

      // 2. Perform restore
      const restoreResult = await service.restoreMaturedRecord(1, { actor: 'GRESTORER' });
      expect(restoreResult.status).toBe('VERIFIED');
      expect(restoreResult.lifecycle.state).toBe(ArchiveState.Active);
      expect(restoreResult.lifecycle.restoredBy).toBe('GRESTORER');
      expect(restoreResult.lifecycle.history).toHaveLength(2); // archive + restore
      expect(restoreResult.lifecycle.history[1].action).toBe('restore');

      const isArchived = await service.isBondArchived(1);
      expect(isArchived).toBe(false);
    });
  });

  describe('Failure Path: Guarding Against Invariant & Policy Violations', () => {
    it('rejects archiving an active (non-matured) bond', async () => {
      await expect(
        service.archiveMaturedRecord(2, {
          reason: 'Premature archival attempt',
          actor: 'GADMIN123',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects archiving without a reason or actor', async () => {
      await expect(
        service.archiveMaturedRecord(1, { reason: '', actor: 'GADMIN123' }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.archiveMaturedRecord(1, { reason: 'Valid reason', actor: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects archiving a bond that is already archived', async () => {
      await service.archiveMaturedRecord(1, { reason: 'First archive', actor: 'GADMIN123' });

      await expect(
        service.archiveMaturedRecord(1, { reason: 'Second archive', actor: 'GADMIN123' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects restoring a bond that is not currently archived', async () => {
      await expect(service.restoreMaturedRecord(1, { actor: 'GADMIN123' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('fails restore verification when financial invariants are violated', async () => {
      await service.archiveMaturedRecord(1, { reason: 'Archive for invariant test', actor: 'GADMIN123' });

      // Simulate corrupted record where totalSubscribed > totalSupply
      const corruptedRecord: Partial<BondResponse> = {
        ...maturedMockBond,
        totalSupply: '1000',
        totalSubscribed: '5000', // Subscribed > Supply!
      };

      const verification = await service.verifyRestore(1, corruptedRecord);
      expect(verification.status).toBe('FAILED');
      expect(verification.mismatches.some((m) => m.check === 'INVARIANT')).toBe(true);
      expect(verification.mismatches[0].severity).toBe('CRITICAL');
    });

    it('blocks restoration when verification fails and force flag is not provided', async () => {
      await service.archiveMaturedRecord(1, { reason: 'Corrupt test', actor: 'GADMIN123' });

      // Mock verifyRestore to fail
      jest.spyOn(service, 'verifyRestore').mockResolvedValueOnce({
        bondId: 1,
        status: 'FAILED',
        verifiedAt: new Date().toISOString(),
        checks: {
          integrity: { passed: false, message: 'Bad hash' },
          invariants: { passed: false, message: 'Invalid balance' },
          provenance: { passed: true, message: 'OK' },
          derivedIndex: { passed: true, message: 'OK' },
        },
        mismatches: [
          {
            check: 'INTEGRITY',
            severity: 'CRITICAL',
            description: 'Corrupted payload',
            repair: 'Re-sync from cold storage',
          },
        ],
      });

      await expect(service.restoreMaturedRecord(1, { actor: 'GADMIN123', force: false })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('Retry Path: Restoration with Force Override or After Repair', () => {
    it('permits restore with force: true when explicitly authorized by operator', async () => {
      await service.archiveMaturedRecord(1, { reason: 'Test force', actor: 'GADMIN123' });

      jest.spyOn(service, 'verifyRestore').mockResolvedValueOnce({
        bondId: 1,
        status: 'FAILED',
        verifiedAt: new Date().toISOString(),
        checks: {
          integrity: { passed: true, message: 'OK' },
          invariants: { passed: true, message: 'OK' },
          provenance: { passed: true, message: 'OK' },
          derivedIndex: { passed: false, message: 'Missing cache' },
        },
        mismatches: [
          {
            check: 'DERIVED_INDEX',
            severity: 'MEDIUM',
            description: 'Holder index empty',
            repair: 'Reconcile holders after restore',
          },
        ],
      });

      const result = await service.restoreMaturedRecord(1, { actor: 'GADMIN123', force: true });
      expect(result.lifecycle.state).toBe(ArchiveState.Active);
    });
  });
});
