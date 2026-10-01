import { Module } from '@nestjs/common';
import { ExportService } from './services/export.service';
import { DataExportJobHandler } from './handlers/data-export-job.handler';
import { ExportsController } from './controllers/exports.controller';
import { WorkersModule } from '../workers/workers.module';

@Module({
  imports: [WorkersModule],
  controllers: [ExportsController],
  providers: [ExportService, DataExportJobHandler],
  exports: [ExportService, DataExportJobHandler],
})
export class ExportsModule {}
