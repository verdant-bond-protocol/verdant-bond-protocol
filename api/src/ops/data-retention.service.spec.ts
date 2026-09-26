import { Test, TestingModule } from '@nestjs/testing';
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
});
