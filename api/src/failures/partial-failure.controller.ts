import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PartialFailure, PartialFailureDashboard } from './partial-failure.interface';
import { PartialFailureService } from './partial-failure.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

/**
 * Partial failure dashboard API (issue #266).
 *
 * The whole board is admin-only: it exposes every stuck integration across
 * users, not just the caller's own operations.
 */
@Controller('api/v1/operations/failures')
@UseGuards(JwtAuthGuard, AdminGuard)
export class PartialFailureController {
  constructor(private readonly failures: PartialFailureService) {}

  /** Grouped maintainer view (age, severity, retryability, links). */
  @Get()
  dashboard(
    @Body() body: { staleAfterMs?: number } = {},
  ): PartialFailureDashboard {
    return this.failures.dashboard({ staleAfterMs: body.staleAfterMs });
  }

  @Get(':id')
  get(@Param('id') id: string): PartialFailure {
    return this.failures.get(id);
  }

  @Post()
  record(
    @Body()
    body: {
      operationType: string;
      externalRef?: string;
      message: string;
      severity?: PartialFailure['severity'];
      retryable?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): PartialFailure {
    return this.failures.record(body);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string): PartialFailure {
    return this.failures.markRetried(id);
  }

  @Post(':id/resolve')
  resolve(@Param('id') id: string, @Body() body: { note?: string }): PartialFailure {
    return this.failures.resolve(id, body.note);
  }

  @Post(':id/ignore')
  ignore(@Param('id') id: string, @Body() body: { note?: string }): PartialFailure {
    return this.failures.ignore(id, body.note);
  }
}
