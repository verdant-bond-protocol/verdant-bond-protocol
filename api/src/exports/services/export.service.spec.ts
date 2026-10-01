import { Test, TestingModule } from '@nestjs/testing';
import { ExportService } from './export.service';
import { RedisService } from '../../common/services/redis.service';
import { ExportType } from '../interfaces/export.interface';

describe('ExportService', () => {
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

  describe('createExport', () => {
    it('should create an export record', async () => {
      const exportRecord = await service.createExport('user-123', ExportType.PORTFOLIO);

      expect(exportRecord.userId).toBe('user-123');
      expect(exportRecord.status).toBe('pending');
      expect(exportRecord.schema.version).toBe('1.0.0');
      expect(exportRecord.schema.recordTypes).toContain(ExportType.PORTFOLIO);
      expect(redisService.set).toHaveBeenCalled();
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

  describe('validateExportAccess', () => {
    it('should allow access for authenticated users', async () => {
      const hasAccess = await service.validateExportAccess('user-123', [ExportType.PORTFOLIO]);
      expect(hasAccess).toBe(true);
    });
  });
});
