import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  DependencyGraph,
  FailureTrendExport,
  PartialFailure,
  PartialFailureDashboard,
  PartialFailureListFilter,
  RejectedOperationExplanation,
} from './partial-failure.interface';
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
    @Query() query: PartialFailureListFilter & { staleAfterMs?: string } = {},
  ): PartialFailureDashboard {
    return this.failures.dashboard({
      staleAfterMs: query.staleAfterMs ? Number(query.staleAfterMs) : undefined,
      filter: {
        operationType: query.operationType,
        status: query.status,
        severity: query.severity,
        retryable: query.retryable === undefined ? undefined : query.retryable === true || String(query.retryable) === 'true',
        externalRef: query.externalRef,
        text: query.text,
        staleOnly: query.staleOnly === undefined ? undefined : query.staleOnly === true || String(query.staleOnly) === 'true',
        minRetryCount: query.minRetryCount === undefined ? undefined : Number(query.minRetryCount),
        createdAfter: query.createdAfter,
        createdBefore: query.createdBefore,
      },
    });
  }

  @Get('trends')
  trends(
    @Query() query: { bucketMs?: string; format?: 'json' | 'csv'; from?: string; to?: string } = {},
  ): FailureTrendExport {
    return this.failures.trendExport({
      bucketMs: query.bucketMs ? Number(query.bucketMs) : undefined,
      format: query.format,
      from: query.from ? Date.parse(query.from) : undefined,
      to: query.to ? Date.parse(query.to) : undefined,
    });
  }

  @Get('dependencies')
  dependencies(@Query('rootId') rootId?: string): DependencyGraph {
    return this.failures.dependencyGraph(rootId);
  }

  @Get('rejections/:code/explanation')
  explainRejectedOperation(
    @Param('code') code: string,
    @Query('supportReference') supportReference?: string,
  ): RejectedOperationExplanation {
    return this.failures.explainRejectedOperation(code, { supportReference });
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
