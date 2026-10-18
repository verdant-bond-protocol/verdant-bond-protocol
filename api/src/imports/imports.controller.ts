import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  GoneException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { ImportBatch, ImportFormat, ImportTraceEntry, PreviewRow } from './import.interface';
import { ImportPipelineError, ImportPipelineService } from './import-pipeline.service';

/** Map pipeline refusals to 4xx/503 rather than a 500. */
function toHttpError(error: unknown): never {
  if (error instanceof ImportPipelineError) {
    switch (error.code) {
      case 'NOT_FOUND':
        throw new NotFoundException(error.message);
      case 'INVALID_REQUEST':
        throw new BadRequestException(error.message);
      case 'PREVIEW_EXPIRED':
        throw new GoneException(error.message);
      case 'DISABLED':
      case 'CAPACITY':
        throw new ServiceUnavailableException(error.message);
      default:
        throw new ConflictException({ message: error.message, code: error.code });
    }
  }
  throw error;
}

async function run<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    toHttpError(error);
  }
}

/**
 * Secure import pipeline API. Admin-only: an import writes compliance state
 * (KYC) for many investors at once. See docs/import-pipeline.md.
 */
@Controller('api/v1/imports')
@UseGuards(JwtAuthGuard, AdminGuard)
export class ImportsController {
  constructor(private readonly imports: ImportPipelineService) {}

  @Get('kinds')
  kinds() {
    return this.imports.kinds();
  }

  @Get()
  list() {
    return this.imports.list();
  }

  /** Every import that wrote to one record (e.g. an investor address). */
  @Get('trace')
  trace(@Query('key') key?: string): Promise<ImportTraceEntry[]> {
    return run(() => {
      if (!key) throw new ImportPipelineError('INVALID_REQUEST', 'key query parameter is required');
      return this.imports.traceForKey(key);
    });
  }

  @Post(':kind/preview')
  preview(
    @Param('kind') kind: string,
    @Body() body: { format?: ImportFormat; rows?: unknown; csv?: unknown; sourceName?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<ImportBatch> {
    return run(() =>
      this.imports.preview({
        kind,
        format: body?.format ?? (typeof body?.csv === 'string' ? 'csv' : 'json'),
        rows: body?.rows,
        csv: body?.csv,
        sourceName: typeof body?.sourceName === 'string' ? body.sourceName.slice(0, 200) : null,
        actor: req.user.walletAddress,
      }),
    );
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<ImportBatch> {
    return run(() => this.imports.get(id));
  }

  @Get(':id/quarantine')
  quarantine(@Param('id') id: string): Promise<PreviewRow[]> {
    return run(() => this.imports.quarantined(id));
  }

  /** Commit, or resume a partially_committed batch (the retry path). */
  @Post(':id/commit')
  commit(
    @Param('id') id: string,
    @Body() body: { previewHash?: string; allowDuplicate?: boolean },
    @Req() req: AuthenticatedRequest,
  ): Promise<ImportBatch> {
    return run(() =>
      this.imports.commit(id, {
        previewHash: body?.previewHash ?? '',
        allowDuplicate: body?.allowDuplicate === true,
        actor: req.user.walletAddress,
      }),
    );
  }

  @Post(':id/rollback')
  rollback(
    @Param('id') id: string,
    @Body() body: { previewHash?: string },
    @Req() req: AuthenticatedRequest,
  ): Promise<ImportBatch> {
    return run(() => this.imports.rollback(id, { previewHash: body?.previewHash ?? '', actor: req.user.walletAddress }));
  }

  @Post(':id/discard')
  discard(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<ImportBatch> {
    return run(() => this.imports.discard(id, req.user.walletAddress));
  }
}
