import { Module } from '@nestjs/common';
import { ExportService } from './services/export.service';
import { ExportStreamPipeline } from './services/export-stream.pipeline';
import { DataExportJobHandler } from './handlers/data-export-job.handler';
import { ExportsController } from './controllers/exports.controller';
import { WorkersModule } from '../workers/workers.module';

@Module({
  imports: [WorkersModule],
  controllers: [ExportsController],
  providers: [ExportService, ExportStreamPipeline, DataExportJobHandler],
  exports: [ExportService, ExportStreamPipeline, DataExportJobHandler],
})
export class ExportsModule {}
