import { Controller, Post, Get, Param, UseGuards, Body, Request } from '@nestjs/common';
import { ExportService } from '../services/export.service';
import { DataExport, ExportType, ExportRole } from '../interfaces/export.interface';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JobQueueService } from '../../workers/services/job-queue.service';
import { JobPayload, JobType } from '../../workers/interfaces/job.interface';

@Controller('api/v1/exports')
@UseGuards(JwtAuthGuard)
export class ExportsController {
  constructor(
    private readonly exportService: ExportService,
    private readonly jobQueue: JobQueueService,
  ) {}

  @Post('request')
  async requestExport(
    @Request() req: any,
    @Body() body: { exportType: ExportType },
  ): Promise<DataExport> {
    const userId = req.user.sub;
    const userRole = (req.user.role as ExportRole) || ExportRole.INVESTOR;

    const exportRecord = await this.exportService.createExport(userId, body.exportType, userRole);

    // Enqueue background job for large exports
    const jobPayload: JobPayload = {
      type: JobType.DATA_EXPORT,
      data: {
        exportId: exportRecord.id,
        userId,
        recordType: body.exportType,
        userRole,
      },
      userId,
      correlationId: exportRecord.id,
    };

    try {
      await this.jobQueue.enqueue(jobPayload, 3);
    } catch (error) {
      // Not admitted (#391 backpressure, or queue unavailable): cancel the
      // record so it does not sit in `pending` with no job behind it. The
      // client retries with a fresh request after Retry-After.
      await this.exportService.cancelExport(exportRecord.id, userId, userRole).catch(() => undefined);
      throw error;
    }

    return exportRecord;
  }

  @Get(':exportId')
  async getExport(@Param('exportId') exportId: string, @Request() req: any): Promise<DataExport | null> {
    const userId = req.user.sub;
    return this.exportService.getExport(exportId, userId);
  }

  @Post(':exportId/cancel')
  async cancelExport(
    @Param('exportId') exportId: string,
    @Request() req: any,
  ): Promise<DataExport> {
    const userId = req.user.sub;
    const userRole = (req.user.role as ExportRole) || ExportRole.INVESTOR;
    return this.exportService.cancelExport(exportId, userId, userRole);
  }

  @Get('status/:exportId')
  async getExportStatus(
    @Param('exportId') exportId: string,
    @Request() req: any,
  ): Promise<{ status: string; recordCount: number; expiresAt: Date }> {
    const userId = req.user.sub;
    const exportRecord = await this.exportService.getExport(exportId, userId);

    if (!exportRecord) {
      throw new Error('Export not found');
    }

    return {
      status: exportRecord.status,
      recordCount: exportRecord.recordCount,
      expiresAt: exportRecord.expiresAt,
    };
  }
}
