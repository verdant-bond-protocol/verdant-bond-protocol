import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { IMPORT_ADMIN_ROLE, ImportOperationView, ImportsService } from './imports.service';
import { StartImportDto } from './dto/start-import.dto';

@ApiTags('imports')
@Controller('api/v1/imports/operations')
@UseGuards(JwtAuthGuard)
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /** Start a long-running import. Responds once the import completes or is cancelled. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Body() dto: StartImportDto, @Req() req: AuthenticatedRequest): Promise<ImportOperationView> {
    return this.imports.startImport(this.userId(req), dto.rows, { chunkSize: dto.chunkSize });
  }

  @Get()
  list(@Req() req: AuthenticatedRequest): ImportOperationView[] {
    return this.imports.listImports();
  }

  @Get(':operationId')
  get(@Param('operationId') operationId: string): ImportOperationView {
    return this.imports.getImport(operationId);
  }

  /** Request cancellation. Idempotent; safe to call after completion. */
  @Post(':operationId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('operationId') operationId: string,
    @Req() req: AuthenticatedRequest,
  ): ImportOperationView {
    return this.imports.cancelImport(operationId, this.actor(req));
  }

  /** Retry a cancelled or failed import. */
  @Post(':operationId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retry(
    @Param('operationId') operationId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ImportOperationView> {
    return this.imports.retryImport(operationId, this.actor(req));
  }

  private actor(req: AuthenticatedRequest): { userId: string; role?: string } {
    const roles = req.user?.roles ?? [];
    return {
      userId: this.userId(req),
      role: roles.includes(IMPORT_ADMIN_ROLE) ? IMPORT_ADMIN_ROLE : roles[0],
    };
  }

  private userId(req: AuthenticatedRequest): string {
    return req.user?.walletAddress ?? 'anonymous';
  }
}
