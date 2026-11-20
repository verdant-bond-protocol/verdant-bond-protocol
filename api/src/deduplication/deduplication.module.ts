import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { ProjectsModule } from '../projects/projects.module';
import { DeduplicationController } from './deduplication.controller';
import { DeduplicationService } from './deduplication.service';
import { KycDeduplicationAdapter } from './adapters/kyc-deduplication.adapter';
import { ProjectDeduplicationAdapter } from './adapters/project-deduplication.adapter';

@Module({
  imports: [AuthModule, AuditModule, ProjectsModule],
  controllers: [DeduplicationController],
  providers: [
    DeduplicationService,
    KycDeduplicationAdapter,
    ProjectDeduplicationAdapter,
  ],
  exports: [DeduplicationService],
})
export class DeduplicationModule {}
