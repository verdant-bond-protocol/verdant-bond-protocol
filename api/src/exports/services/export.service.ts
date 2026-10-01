import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import {
  DataExport,
  ExportSchema,
  ExportableRecord,
  ExportType,
} from '../interfaces/export.interface';
import { RedisService } from '../../common/services/redis.service';
import * as crypto from 'crypto';

const EXPORT_SCHEMA_VERSION = '1.0.0';
const DEFAULT_RETENTION_DAYS = 30;

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly EXPORT_KEY_PREFIX = 'export:';

  constructor(private readonly redis: RedisService) {}

  async createExport(userId: string, exportType: ExportType): Promise<DataExport> {
    const exportId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const exportRecord: DataExport = {
      id: exportId,
      userId,
      status: 'pending',
      schema: {
        version: EXPORT_SCHEMA_VERSION,
        generatedAt: new Date(),
        generatedBy: userId,
        recordTypes: [exportType],
        retentionDays: DEFAULT_RETENTION_DAYS,
      },
      recordCount: 0,
      expiresAt,
      createdAt: new Date(),
    };

    const exportKey = `${this.EXPORT_KEY_PREFIX}${exportId}`;
    await this.redis.set(exportKey, JSON.stringify(exportRecord));
    await this.redis.expire(exportKey, DEFAULT_RETENTION_DAYS * 24 * 60 * 60);

    this.logger.log(`Created export ${exportId} for user ${userId} of type ${exportType}`);
    return exportRecord;
  }

  async getExport(exportId: string, userId: string): Promise<DataExport | null> {
    const exportKey = `${this.EXPORT_KEY_PREFIX}${exportId}`;
    const exportData = await this.redis.get(exportKey);

    if (!exportData) {
      return null;
    }

    const exportRecord = JSON.parse(exportData) as DataExport;

    // Authorization check: user can only access their own exports
    if (exportRecord.userId !== userId) {
      throw new ForbiddenException('Cannot access export outside your authorization scope');
    }

    // Check expiration
    if (new Date() > exportRecord.expiresAt) {
      await this.redis.del(exportKey);
      return null;
    }

    return exportRecord;
  }

  async updateExportStatus(
    exportId: string,
    status: 'pending' | 'processing' | 'completed' | 'failed',
    data?: { recordCount?: number; filePath?: string; error?: string },
  ): Promise<void> {
    const exportKey = `${this.EXPORT_KEY_PREFIX}${exportId}`;
    const exportData = await this.redis.get(exportKey);

    if (!exportData) {
      this.logger.warn(`Export ${exportId} not found during status update`);
      return;
    }

    const exportRecord = JSON.parse(exportData) as DataExport;
    exportRecord.status = status;

    if (data?.recordCount !== undefined) exportRecord.recordCount = data.recordCount;
    if (data?.filePath !== undefined) exportRecord.filePath = data.filePath;
    if (data?.error !== undefined) exportRecord.error = data.error;

    if (status === 'completed' || status === 'failed') {
      exportRecord.completedAt = new Date();
    }

    await this.redis.set(exportKey, JSON.stringify(exportRecord));
    this.logger.log(`Updated export ${exportId} status to ${status}`);
  }

  async generateExportData(
    records: ExportableRecord[],
  ): Promise<{ schema: ExportSchema; data: ExportableRecord[] }> {
    const recordTypes = [...new Set(records.map((r) => r.type))];

    const schema: ExportSchema = {
      version: EXPORT_SCHEMA_VERSION,
      generatedAt: new Date(),
      generatedBy: 'system',
      recordTypes,
      retentionDays: DEFAULT_RETENTION_DAYS,
    };

    return { schema, data: records };
  }

  async validateExportAccess(userId: string, requestedRecordTypes: string[]): Promise<boolean> {
    // For now, all authenticated users can export their own data
    // This can be extended with more granular permission checks
    return true;
  }
}
