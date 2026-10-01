import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { LifecycleError } from '../common/lifecycle/record-lifecycle';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import {
  DependencyGraph,
  FailureTrendExport,
  PartialFailure,
  PartialFailureDashboard,
  PartialFailureListFilter,
  RejectedOperationExplanation,
} from './partial-failure.interface';
import { PartialFailureService } from './partial-failure.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

/** Map a refused lifecycle transition to a 4xx rather than a 500. */
function toHttpError(error: unknown): never {
  if (error instanceof LifecycleError) {
    if (error.code === 'already_archived' || error.code === 'not_archived') {
      throw new ConflictException(error.message);
    }
    throw new BadRequestException(error.message);
  }
  if (error instanceof Error && error.message.startsWith('no partial failure ')) {
    throw new NotFoundException(error.message);
  }
  throw error;
}

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

  /**
   * Grouped maintainer view (age, severity, retryability, links).
   *
   * Archived failures are off the board by default; `?includeArchived=true`
   * opts back in for an operator auditing what was archived and why.
   */
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
        includeArchived: query.includeArchived === undefined
          ? undefined
          : query.includeArchived === true || String(query.includeArchived) === 'true',
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
    try {
      return this.failures.get(id);
    } catch (error) {
      toHttpError(error);
    }
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
    try {
      return this.failures.markRetried(id);
    } catch (error) {
      toHttpError(error);
    }
  }

  @Post(':id/resolve')
  resolve(@Param('id') id: string, @Body() body: { note?: string }): PartialFailure {
    try {
      return this.failures.resolve(id, body.note);
    } catch (error) {
      toHttpError(error);
    }
  }

  /**
   * Archive a failure: an explicit, attributed, reversible decision to stop
   * tracking it. A reason is mandatory — a record that leaves the board
   * without a written justification is a bug, not a moderation action.
   */
  @Post(':id/archive')
  archive(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Req() req: AuthenticatedRequest,
  ): PartialFailure {
    try {
      return this.failures.archive(id, req.user.walletAddress, body.reason ?? '');
    } catch (error) {
      toHttpError(error);
    }
  }

  /** Restore an archived failure. The archive stays in the record's history. */
  @Post(':id/restore')
  restore(@Param('id') id: string, @Req() req: AuthenticatedRequest): PartialFailure {
    try {
      return this.failures.restore(id, req.user.walletAddress);
    } catch (error) {
      toHttpError(error);
    }
  }
}
