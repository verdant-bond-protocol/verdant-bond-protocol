import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import {
  DataExport,
  ExportSchema,
  ExportableRecord,
  ExportType,
  ExportStatus,
  ExportCaller,
  ExportRole,
  ExportStreamOptions,
  ExportStreamResult,
} from '../interfaces/export.interface';
import { RedisService } from '../../common/services/redis.service';
import { ExportStreamPipeline } from './export-stream.pipeline';
import { ExportRedactionMode } from './export-field-redaction';
import * as crypto from 'crypto';

const EXPORT_SCHEMA_VERSION = '1.0.0';
const DEFAULT_RETENTION_DAYS = 30;

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly EXPORT_KEY_PREFIX = 'export:';
  private readonly CANCEL_KEY_PREFIX = 'export:cancel:';
  private readonly pipeline: ExportStreamPipeline;

  constructor(
    private readonly redis: RedisService,
    @Optional() pipeline?: ExportStreamPipeline,
  ) {
    this.pipeline = pipeline ?? new ExportStreamPipeline();
  }

  async createExport(userId: string, exportType: ExportType, callerRole: ExportRole = ExportRole.INVESTOR): Promise<DataExport> {
    const caller: ExportCaller = { userId, role: callerRole };
    if (!this.pipeline.validatePermission(caller, exportType)) {
      throw new ForbiddenException(`Role ${callerRole} is not authorized to export ${exportType}`);
    }

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
    if (new Date() > new Date(exportRecord.expiresAt)) {
      await this.redis.del(exportKey);
      return null;
    }

    return exportRecord;
  }

  async cancelExport(exportId: string, userId: string, userRole: ExportRole = ExportRole.INVESTOR): Promise<DataExport> {
    const exportKey = `${this.EXPORT_KEY_PREFIX}${exportId}`;
    const exportData = await this.redis.get(exportKey);

    if (!exportData) {
      throw new NotFoundException(`Export ${exportId} not found`);
    }

    const exportRecord = JSON.parse(exportData) as DataExport;

    // Authorization check: owner or admin can cancel
    if (exportRecord.userId !== userId && userRole !== ExportRole.ADMIN) {
      throw new ForbiddenException('Cannot cancel export outside your authorization scope');
    }

    if (exportRecord.status === 'completed') {
      throw new BadRequestException('Cannot cancel an already completed export');
    }

    if (exportRecord.status === 'cancelled') {
      return exportRecord;
    }

    exportRecord.status = 'cancelled';
    exportRecord.cancelledAt = new Date();

    await this.redis.set(exportKey, JSON.stringify(exportRecord));
    // Set immediate cancellation flag for active streams to see
    const cancelKey = `${this.CANCEL_KEY_PREFIX}${exportId}`;
    await this.redis.set(cancelKey, 'true');
    await this.redis.expire(cancelKey, 3600);

    this.logger.warn(`Export ${exportId} was cancelled by user ${userId}`);
    return exportRecord;
  }

  async isExportCancelled(exportId: string): Promise<boolean> {
    const cancelKey = `${this.CANCEL_KEY_PREFIX}${exportId}`;
    const val = await this.redis.get(cancelKey);
    return val === 'true';
  }

  async updateExportStatus(
    exportId: string,
    status: ExportStatus,
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
    } else if (status === 'cancelled') {
      exportRecord.cancelledAt = new Date();
    }

    await this.redis.set(exportKey, JSON.stringify(exportRecord));
    this.logger.log(`Updated export ${exportId} status to ${status}`);
  }

  async streamExportDataset(
    exportId: string,
    exportType: ExportType,
    source: AsyncIterable<ExportableRecord[]>,
    caller: ExportCaller,
    abortSignal?: AbortSignal,
    chunkConsumer?: (chunk: ExportableRecord[]) => Promise<void>,
    redaction?: ExportRedactionMode,
  ): Promise<ExportStreamResult> {
    const result = await this.pipeline.streamExport(
      exportId,
      exportType,
      source,
      { caller, abortSignal, redaction },
      chunkConsumer,
      () => this.isExportCancelled(exportId),
    );

    await this.updateExportStatus(exportId, result.status, {
      recordCount: result.totalRecordsProcessed,
      error: result.error,
    });

    return result;
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
    return true;
  }

  validateCallerPermission(caller: ExportCaller, exportType: ExportType): boolean {
    return this.pipeline.validatePermission(caller, exportType);
  }
}
