import { Test, TestingModule } from '@nestjs/testing';
import { ExportService } from './export.service';
import { RedisService } from '../../common/services/redis.service';
import { ExportType, ExportRole } from '../interfaces/export.interface';
import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';

describe('ExportService (#357 Permission & Cancellation)', () => {
  let service: ExportService;
  let redisService: RedisService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExportService,
        {
          provide: RedisService,
          useValue: {
            set: jest.fn(),
            get: jest.fn(),
            del: jest.fn(),
            expire: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ExportService>(ExportService);
    redisService = module.get<RedisService>(RedisService);
  });

  describe('createExport with caller permissions', () => {
    it('should create an export record for allowed export types', async () => {
      const exportRecord = await service.createExport('user-123', ExportType.PORTFOLIO, ExportRole.INVESTOR);

      expect(exportRecord.userId).toBe('user-123');
      expect(exportRecord.status).toBe('pending');
      expect(exportRecord.schema.version).toBe('1.0.0');
      expect(exportRecord.schema.recordTypes).toContain(ExportType.PORTFOLIO);
      expect(redisService.set).toHaveBeenCalled();
    });

    it('rejects export request when caller role lacks permission for the type', async () => {
      // INVESTOR cannot export KYC_PII or COMPLIANCE_AUDIT
      await expect(
        service.createExport('user-123', ExportType.KYC_PII, ExportRole.INVESTOR),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows ADMIN to export KYC_PII and COMPLIANCE_AUDIT', async () => {
      const exportRecord = await service.createExport('admin-1', ExportType.KYC_PII, ExportRole.ADMIN);
      expect(exportRecord.userId).toBe('admin-1');
      expect(exportRecord.schema.recordTypes).toContain(ExportType.KYC_PII);
    });
  });

  describe('getExport', () => {
    it('should return export if user is authorized', async () => {
      const mockExport = {
        id: 'export-1',
        userId: 'user-123',
        status: 'completed',
        expiresAt: new Date(Date.now() + 1000000).toISOString(),
      };

      (redisService.get as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockExport));

      const result = await service.getExport('export-1', 'user-123');
      expect(result).toEqual(mockExport);
    });

    it('should throw if user not authorized', async () => {
      const mockExport = {
        id: 'export-1',
        userId: 'user-123',
        status: 'completed',
        expiresAt: new Date(Date.now() + 1000000),
      };

      (redisService.get as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockExport));

      await expect(service.getExport('export-1', 'user-999')).rejects.toThrow(
        'Cannot access export outside your authorization scope',
      );
    });
  });

  describe('cancelExport', () => {
    it('successfully cancels a pending or processing export when called by owner', async () => {
      const mockExport = {
        id: 'export-pending-1',
        userId: 'user-123',
        status: 'processing',
        expiresAt: new Date(Date.now() + 1000000).toISOString(),
      };

      (redisService.get as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockExport));

      const cancelled = await service.cancelExport('export-pending-1', 'user-123', ExportRole.INVESTOR);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.cancelledAt).toBeDefined();
      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringContaining('export:cancel:export-pending-1'),
        'true',
      );
    });

    it('allows ADMIN to cancel an export owned by another user', async () => {
      const mockExport = {
        id: 'export-pending-2',
        userId: 'user-other',
        status: 'processing',
        expiresAt: new Date(Date.now() + 1000000).toISOString(),
      };

      (redisService.get as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockExport));

      const cancelled = await service.cancelExport('export-pending-2', 'admin-user', ExportRole.ADMIN);
      expect(cancelled.status).toBe('cancelled');
    });

    it('rejects cancellation from an unauthorized non-admin user', async () => {
      const mockExport = {
        id: 'export-3',
        userId: 'user-alice',
        status: 'processing',
        expiresAt: new Date(Date.now() + 1000000).toISOString(),
      };

      (redisService.get as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockExport));

      await expect(
        service.cancelExport('export-3', 'user-bob', ExportRole.INVESTOR),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects cancellation of an already completed export', async () => {
      const mockExport = {
        id: 'export-completed',
        userId: 'user-123',
        status: 'completed',
        expiresAt: new Date(Date.now() + 1000000).toISOString(),
      };

      (redisService.get as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockExport));

      await expect(
        service.cancelExport('export-completed', 'user-123', ExportRole.INVESTOR),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('validateExportAccess', () => {
    it('should allow access for authenticated users', async () => {
      const hasAccess = await service.validateExportAccess('user-123', [ExportType.PORTFOLIO]);
      expect(hasAccess).toBe(true);
    });
  });
});
