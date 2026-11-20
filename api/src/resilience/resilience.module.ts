import { Module } from '@nestjs/common';
import { FailuresModule } from '../failures/failures.module';
import { StatusModule } from '../status/status.module';
import { PermissionDiffService } from '../auth/permission-diff.service';
import { WorkflowResilienceService } from './workflow-resilience.service';

/**
 * A single cohesive slice over the existing Failures, Status and RBAC
 * capabilities. It deliberately adds no new persistence layer: all state it
 * surfaces already lives in services that support attribution and rollback.
 */
@Module({
  imports: [FailuresModule, StatusModule],
  providers: [WorkflowResilienceService, PermissionDiffService],
  exports: [WorkflowResilienceService],
})
export class ResilienceModule {}
