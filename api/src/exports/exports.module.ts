import { Module } from '@nestjs/common';
import { ExportService } from './services/export.service';
import { ExportStreamPipeline } from './services/export-stream.pipeline';
import { DataExportJobHandler } from './handlers/data-export-job.handler';
import { ExportsController } from './controllers/exports.controller';
import { InvestorComplianceExportController } from './controllers/investor-compliance-export.controller';
import { InvestorComplianceExportService } from './services/investor-compliance-export.service';
import { WorkersModule } from '../workers/workers.module';

@Module({
  imports: [WorkersModule],
  controllers: [ExportsController, InvestorComplianceExportController],
  providers: [
    ExportService,
    ExportStreamPipeline,
    DataExportJobHandler,
    InvestorComplianceExportService,
  ],
  exports: [
    ExportService,
    ExportStreamPipeline,
    DataExportJobHandler,
    InvestorComplianceExportService,
  ],
})
export class ExportsModule {}
