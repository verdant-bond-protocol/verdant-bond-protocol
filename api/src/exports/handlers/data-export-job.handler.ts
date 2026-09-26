import { Injectable, Logger } from '@nestjs/common';
import { JobHandler } from '../../workers/services/worker.service';
import { ExportService } from '../services/export.service';

@Injectable()
export class DataExportJobHandler implements JobHandler {
  private readonly logger = new Logger(DataExportJobHandler.name);

  constructor(private readonly exportService: ExportService) {}

  async handle(payload: any): Promise<Record<string, any>> {
    const { exportId, userId, recordType } = payload;

    this.logger.log(`Processing data export ${exportId} for user ${userId}, type ${recordType}`);

    // Update export status to processing
    await this.exportService.updateExportStatus(exportId, 'processing');

    try {
      // Simulate collecting records - in production, this would fetch from database
      const mockRecords = Array.from({ length: 100 }, (_, i) => ({
        id: `${recordType}-${i}`,
        type: recordType,
        createdAt: new Date(),
        data: { index: i, userId },
      }));

      const exportData = await this.exportService.generateExportData(mockRecords);

      // In production, this would write to a file storage service (S3, etc)
      const filePath = `/exports/${exportId}.json`;

      await this.exportService.updateExportStatus(exportId, 'completed', {
        recordCount: mockRecords.length,
        filePath,
      });

      return {
        exportId,
        recordCount: mockRecords.length,
        filePath,
        schemaVersion: exportData.schema.version,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.exportService.updateExportStatus(exportId, 'failed', { error: errorMsg });
      throw error;
    }
  }
}
