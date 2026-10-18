import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { ImportPipelineService } from './import-pipeline.service';
import { ImportsController } from './imports.controller';
import { KycImportSink } from './kyc-import.sink';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [ImportsController],
  providers: [ImportPipelineService, KycImportSink],
  exports: [ImportPipelineService],
})
export class ImportsModule {}
