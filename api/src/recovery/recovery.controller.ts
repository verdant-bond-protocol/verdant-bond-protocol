import { Controller, Post, Get, Param, Body, UseGuards } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { RecoveryOperation } from './recovery.interface';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

/**
 * Recovery API (issue #261).
 *
 * Starting and resuming an operation is authenticated for the owning
 * principal; diagnostics and abandonment are admin-only because they expose
 * every in-flight operation in the system, not just the caller's own.
 */
@Controller('api/v1/recovery')
@UseGuards(JwtAuthGuard)
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  /** Resume from the last checkpoint. Idempotent; never re-applies side effects. */
  @Post(':operationId/resume')
  async resume(@Param('operationId') operationId: string): Promise<RecoveryOperation> {
    return this.recovery.resume(operationId);
  }

  /** User-visible next steps after an interruption. */
  @Get(':operationId/actions')
  async actions(@Param('operationId') operationId: string) {
    return this.recovery.getUserActions(operationId);
  }

  @Get(':operationId')
  async operation(@Param('operationId') operationId: string) {
    return this.recovery.getOperation(operationId);
  }

  @Get('diagnostics')
  @UseGuards(AdminGuard)
  async diagnostics(@Body() body: { stuckAfterMs?: number } = {}) {
    return this.recovery.getDiagnostics(Date.now());
  }

  @Post(':operationId/abandon')
  @UseGuards(AdminGuard)
  async abandon(
    @Param('operationId') operationId: string,
    @Body() body: { olderThanMs?: number },
  ): Promise<{ abandoned: boolean }> {
    const abandoned = await this.recovery.markAbandoned(operationId, body?.olderThanMs);
    return { abandoned };
  }
}
