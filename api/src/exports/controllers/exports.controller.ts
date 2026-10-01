import { Controller, Post, Get, Param, UseGuards, Body, Request } from '@nestjs/common';
import { ExportService } from '../services/export.service';
import { DataExport, ExportType } from '../interfaces/export.interface';
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

    // Validate export access
    const hasAccess = await this.exportService.validateExportAccess(userId, [body.exportType]);
    if (!hasAccess) {
      throw new Error('User does not have access to this export type');
    }

    const exportRecord = await this.exportService.createExport(userId, body.exportType);

    // Enqueue background job for large exports
    const jobPayload: JobPayload = {
      type: JobType.DATA_EXPORT,
      data: {
        exportId: exportRecord.id,
        userId,
        recordType: body.exportType,
      },
      userId,
      correlationId: exportRecord.id,
    };

    await this.jobQueue.enqueue(jobPayload, 3);

    return exportRecord;
  }

  @Get(':exportId')
  async getExport(@Param('exportId') exportId: string, @Request() req: any): Promise<DataExport | null> {
    const userId = req.user.sub;
    return this.exportService.getExport(exportId, userId);
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
