import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { ImportsController as LongRunningImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { BulkImportService } from '../common/services/bulk-import.service';
import { ImportPipelineService } from './import-pipeline.service';
import { ImportsController as PipelineImportsController } from './imports.controller';
import { KycImportSink } from './kyc-import.sink';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [LongRunningImportsController, PipelineImportsController],
  providers: [ImportsService, BulkImportService, ImportPipelineService, KycImportSink],
  exports: [ImportsService, ImportPipelineService],
})
export class ImportsModule {}
