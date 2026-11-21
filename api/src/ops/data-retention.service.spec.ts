import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { DataRetentionService, DataType, RETENTION_DAYS } from './data-retention.service';
import { OracleIncidentRepository } from '../oracle/oracle-incident.repository';
import * as fs from 'fs';
import * as path from 'path';
import { OracleIncidentStatus, OracleIncidentSeverity } from '../oracle/interfaces/oracle-incident.interface';

jest.mock('fs', () => {
  return {
    promises: {
      stat: jest.fn(),
      readdir: jest.fn(),
      unlink: jest.fn(),
      readFile: jest.fn(),
    },
  };
});

describe('DataRetentionService', () => {
  let service: DataRetentionService;
  let mockOracleRepo: jest.Mocked<Partial<OracleIncidentRepository>>;
  let fileFs: typeof fs.promises;

  beforeEach(async () => {
    mockOracleRepo = {
      findMany: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataRetentionService,
        { provide: OracleIncidentRepository, useValue: mockOracleRepo },
      ],
    }).compile();

    service = module.get<DataRetentionService>(DataRetentionService);
    fileFs = fs.promises;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should delete eligible telemetry records', async () => {
    (fileFs.stat as jest.Mock).mockImplementation(async (p: string) => {
      if (p.includes('telemetry')) {
        if (p.endsWith('telemetry')) {
          return { isDirectory: () => true };
        }
        // Mock a file older than 30 days
        return { isFile: () => true, mtimeMs: Date.now() - (31 * 24 * 60 * 60 * 1000) };
      }
      return { isDirectory: () => false };
    });

    (fileFs.readdir as jest.Mock).mockResolvedValue(['old-log.jsonl']);
    (fileFs.unlink as jest.Mock).mockResolvedValue(undefined);

    await service.runCleanupJob();

    expect(fileFs.unlink).toHaveBeenCalledWith(expect.stringContaining('old-log.jsonl'));
  });

  it('should not delete records within retention period', async () => {
    (fileFs.stat as jest.Mock).mockImplementation(async (p: string) => {
      if (p.includes('telemetry')) {
        if (p.endsWith('telemetry')) {
          return { isDirectory: () => true };
        }
        // Mock a file younger than 30 days
        return { isFile: () => true, mtimeMs: Date.now() - (10 * 24 * 60 * 60 * 1000) };
      }
      return { isDirectory: () => false };
    });

    (fileFs.readdir as jest.Mock).mockResolvedValue(['recent-log.jsonl']);

    await service.runCleanupJob();

    expect(fileFs.unlink).not.toHaveBeenCalled();
  });

  it('should protect evidence records linked to active disputes', async () => {
    (fileFs.stat as jest.Mock).mockImplementation(async (p: string) => {
      if (p.includes('evidence')) {
        if (p.endsWith('evidence')) {
          return { isDirectory: () => true };
        }
        // Mock a file older than 5 years
        return { isFile: () => true, mtimeMs: Date.now() - (6 * 365 * 24 * 60 * 60 * 1000) };
      }
      return { isDirectory: () => false };
    });

    (fileFs.readdir as jest.Mock).mockResolvedValue(['evidence-incident-123.pdf']);

    mockOracleRepo.findMany = jest.fn().mockResolvedValue({
      data: [{
        id: 'incident-123',
        subjectId: 'incident-123',
        status: 'active' as OracleIncidentStatus,
        severity: 'critical' as OracleIncidentSeverity,
      }],
      meta: { total: 1 },
    });

    await service.runCleanupJob();

    // The unlink should NOT have been called because it's protected
    expect(fileFs.unlink).not.toHaveBeenCalled();
  });

  describe('verifyEvidenceRetentionCompliance (#643 Data Retention Checks)', () => {
    const adminActor = { isAdmin: true };
    const auditorActor = { roles: ['COMPLIANCE_OFFICER'] };
    const unauthorizedActor = { roles: ['INVESTOR'] };

    it('rejects unauthorized actor without auditor or admin role', async () => {
      await expect(
        service.verifyEvidenceRetentionCompliance(unauthorizedActor),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        service.verifyEvidenceRetentionCompliance(undefined),
      ).rejects.toThrow(ForbiddenException);
    });

    it('successfully audits KYC and financial evidence, correctly classifying compliant records and live store', async () => {
      const now = Date.now();

      (fileFs.stat as jest.Mock).mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('kyc') || filePath.endsWith('evidence')) {
          return { isDirectory: () => true };
        }
        if (filePath.includes('kyc-records.json')) {
          return { isFile: () => true, mtimeMs: now - 100 * 24 * 60 * 60 * 1000 };
        }
        if (filePath.includes('kyc-audit.log.jsonl')) {
          // 2 years old (well within 7 year limit)
          return { isFile: () => true, mtimeMs: now - 2 * 365 * 24 * 60 * 60 * 1000 };
        }
        if (filePath.includes('dispute-evidence-456.pdf')) {
          // 1 year old (within 5 year limit)
          return { isFile: () => true, mtimeMs: now - 365 * 24 * 60 * 60 * 1000 };
        }
        return { isDirectory: () => false, isFile: () => false };
      });

      (fileFs.readdir as jest.Mock).mockImplementation(async (dirPath: string) => {
        if (dirPath.includes('kyc')) return ['kyc-records.json', 'kyc-audit.log.jsonl'];
        if (dirPath.includes('evidence')) return ['dispute-evidence-456.pdf'];
        return [];
      });

      (fileFs.readFile as jest.Mock).mockResolvedValue(Buffer.from('sample evidence data'));

      mockOracleRepo.findMany = jest.fn().mockResolvedValue({
        data: [],
        meta: { total: 0 },
      });

      const report = await service.verifyEvidenceRetentionCompliance(auditorActor, { verifyIntegrity: true });

      expect(report.overallStatus).toBe('COMPLIANT');
      expect(report.summary.totalChecked).toBe(3);
      expect(report.summary.protectedLiveStoreCount).toBe(1);
      expect(report.summary.retainedCompliantCount).toBe(2);
      expect(report.summary.violationsCount).toBe(0);

      // Verify digest was computed
      const evidenceFinding = report.findings.find((f) => f.file === 'dispute-evidence-456.pdf');
      expect(evidenceFinding).toBeDefined();
      expect(evidenceFinding!.sha256Digest).toBeDefined();
      expect(evidenceFinding!.sha256Digest!.length).toBe(64);
    });

    it('protects expired financial evidence with active dispute holds and flags unheld expired as eligible for pruning', async () => {
      const now = Date.now();

      (fileFs.stat as jest.Mock).mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('evidence') || filePath.endsWith('kyc')) return { isDirectory: () => true };
        if (filePath.includes('evidence-incident-789.pdf')) {
          // 6 years old (> 5 years), but linked to active incident 789
          return { isFile: () => true, mtimeMs: now - 6 * 365 * 24 * 60 * 60 * 1000 };
        }
        if (filePath.includes('old-resolved-evidence.pdf')) {
          // 6 years old (> 5 years), not linked to any active incident
          return { isFile: () => true, mtimeMs: now - 6 * 365 * 24 * 60 * 60 * 1000 };
        }
        return { isDirectory: () => false, isFile: () => false };
      });

      (fileFs.readdir as jest.Mock).mockImplementation(async (dirPath: string) => {
        if (dirPath.includes('evidence')) return ['evidence-incident-789.pdf', 'old-resolved-evidence.pdf'];
        return [];
      });

      mockOracleRepo.findMany = jest.fn().mockResolvedValue({
        data: [{
          id: 'incident-789',
          subjectId: 'incident-789',
          status: 'active' as OracleIncidentStatus,
          severity: 'critical' as OracleIncidentSeverity,
        }],
        meta: { total: 1 },
      });

      const report = await service.verifyEvidenceRetentionCompliance(adminActor);

      expect(report.overallStatus).toBe('COMPLIANT');
      expect(report.summary.heldActiveDisputeCount).toBe(1);
      expect(report.summary.eligibleForPruningCount).toBe(1);

      const heldFinding = report.findings.find((f) => f.file === 'evidence-incident-789.pdf');
      expect(heldFinding!.complianceClassification).toBe('HELD_ACTIVE_DISPUTE');
      expect(heldFinding!.isHeld).toBe(true);

      const pruningFinding = report.findings.find((f) => f.file === 'old-resolved-evidence.pdf');
      expect(pruningFinding!.complianceClassification).toBe('ELIGIBLE_FOR_PRUNING');
      expect(pruningFinding!.isHeld).toBe(false);
    });

    it('fails closed and returns NEEDS_REVIEW when incident repository cannot be reached', async () => {
      (fileFs.stat as jest.Mock).mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('evidence') || filePath.endsWith('kyc')) return { isDirectory: () => true };
        return { isFile: () => true, mtimeMs: Date.now() - 6 * 365 * 24 * 60 * 60 * 1000 };
      });

      (fileFs.readdir as jest.Mock).mockImplementation(async (dirPath: string) => {
        if (dirPath.includes('evidence')) return ['some-evidence.pdf'];
        return [];
      });

      mockOracleRepo.findMany = jest.fn().mockRejectedValue(new Error('Database connection failed'));

      const report = await service.verifyEvidenceRetentionCompliance(adminActor);

      expect(report.overallStatus).toBe('NEEDS_REVIEW');
      expect(report.summary.heldActiveDisputeCount).toBe(1);
      expect(report.findings[0].isHeld).toBe(true);
      expect(report.findings[0].holdReason).toContain('Incident store unreachable');
    });

    it('detects unreadable/corrupted files and reports NON_COMPLIANT status', async () => {
      (fileFs.stat as jest.Mock).mockImplementation(async (filePath: string) => {
        if (filePath.endsWith('kyc') || filePath.endsWith('evidence')) return { isDirectory: () => true };
        if (filePath.includes('corrupted-evidence.pdf')) {
          throw new Error('EACCES: permission denied');
        }
        return { isDirectory: () => false, isFile: () => false };
      });

      (fileFs.readdir as jest.Mock).mockImplementation(async (dirPath: string) => {
        if (dirPath.includes('evidence')) return ['corrupted-evidence.pdf'];
        return [];
      });

      mockOracleRepo.findMany = jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } });

      const report = await service.verifyEvidenceRetentionCompliance(adminActor);

      expect(report.overallStatus).toBe('NON_COMPLIANT');
      expect(report.summary.violationsCount).toBe(1);
      expect(report.findings[0].complianceClassification).toBe('FILE_UNREADABLE');
    });
  });
});
