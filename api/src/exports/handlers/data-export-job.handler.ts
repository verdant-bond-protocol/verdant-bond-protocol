import { Injectable, Logger } from '@nestjs/common';
import { JobHandler } from '../../workers/services/worker.service';
import { ExportService } from '../services/export.service';
import { ExportRole, ExportCaller, ExportableRecord } from '../interfaces/export.interface';

@Injectable()
export class DataExportJobHandler implements JobHandler {
  private readonly logger = new Logger(DataExportJobHandler.name);

  constructor(private readonly exportService: ExportService) {}

  async handle(payload: any): Promise<Record<string, any>> {
    const { exportId, userId, recordType, userRole = ExportRole.INVESTOR } = payload;

    this.logger.log(`Processing data export ${exportId} for user ${userId}, type ${recordType}, role ${userRole}`);

    // Check if job was already cancelled before picking up
    if (await this.exportService.isExportCancelled(exportId)) {
      this.logger.warn(`Export ${exportId} was cancelled before worker pickup`);
      return { exportId, status: 'cancelled' };
    }

    // Update export status to processing
    await this.exportService.updateExportStatus(exportId, 'processing');

    try {
      // Chunked generator for bounded memory
      async function* generateChunks(totalCount = 100, chunkSize = 25) {
        for (let i = 0; i < totalCount; i += chunkSize) {
          const currentChunkSize = Math.min(chunkSize, totalCount - i);
          const chunk: ExportableRecord[] = Array.from({ length: currentChunkSize }, (_, idx) => {
            const index = i + idx;
            return {
              id: `${recordType}-${index}`,
              type: recordType,
              createdAt: new Date(),
              ownerUserId: userId,
              data: {
                index,
                userId,
                // Sample fields including forbidden ones to test role scrubbing
                status: 'verified',
                internalRiskScore: 85,
                signingSeed: 'SECRET_SEED_DO_NOT_LEAK',
              },
            };
          });
          yield chunk;
        }
      }

      const caller: ExportCaller = {
        userId,
        role: userRole,
      };

      const filePath = `/exports/${exportId}.json`;
      const streamResult = await this.exportService.streamExportDataset(
        exportId,
        recordType,
        generateChunks(100, 25),
        caller,
      );

      if (streamResult.status === 'cancelled') {
        return {
          exportId,
          status: 'cancelled',
          recordCount: streamResult.totalRecordsProcessed,
        };
      }

      await this.exportService.updateExportStatus(exportId, 'completed', {
        recordCount: streamResult.totalRecordsProcessed,
        filePath,
      });

      return {
        exportId,
        status: 'completed',
        recordCount: streamResult.totalRecordsProcessed,
        filePath,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.exportService.updateExportStatus(exportId, 'failed', { error: errorMsg });
      throw error;
    }
  }
}
