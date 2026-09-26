import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { MigrationSafetyService } from './migration-safety.service';
import { MigrationRunReport } from './migration.interface';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

/**
 * Migration safety API (issue #263).
 *
 * Everything here is admin-only: a migration dry-run enumerates record counts
 * and table shapes, and running one for real is by definition a
 * whole-database mutation.
 */
@Controller('api/v1/migrations')
@UseGuards(JwtAuthGuard, AdminGuard)
export class MigrationSafetyController {
  constructor(private readonly migrations: MigrationSafetyService) {}

  /** Preview affected records without writing anything. */
  @Post(':migrationId/dry-run')
  async dryRun(
    @Param('migrationId') migrationId: string,
    @Body() body: { context?: Record<string, any> },
  ): Promise<MigrationRunReport> {
    return this.migrations.run(migrationId, { dryRun: true, context: body?.context });
  }

  /** Apply, with the preview first and post-checks after. */
  @Post(':migrationId/apply')
  async apply(
    @Param('migrationId') migrationId: string,
    @Body() body: { context?: Record<string, any> },
  ): Promise<MigrationRunReport> {
    return this.migrations.run(migrationId, { dryRun: false, context: body?.context });
  }

  @Get('history')
  async history() {
    return this.migrations.getHistory();
  }

  @Get('registered')
  async registered(): Promise<{ ids: string[] }> {
    return { ids: this.migrations.getRegisteredIds() };
  }
}
