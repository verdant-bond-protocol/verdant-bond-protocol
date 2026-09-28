import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Permission } from '../auth/rbac';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { AuthorizationService, CleanupReport } from './authorization.service';
import { AuthorizationError, AuthorizationGrant } from './authorization.interface';
import { GrantAuthorizationDto } from './dto/grant-authorization.dto';
import { RenewAuthorizationDto } from './dto/renew-authorization.dto';

function toHttpError(error: unknown): never {
  if (error instanceof AuthorizationError) {
    if (error.code === 'not_found') throw new NotFoundException(error.message);
    if (error.code === 'unauthorized_actor') throw new ForbiddenException(error.message);
    throw new BadRequestException(error.message);
  }
  throw error;
}

@ApiTags('authorizations')
@ApiBearerAuth()
@Controller('authorizations')
export class AuthorizationsController {
  constructor(private readonly authorizations: AuthorizationService) {}

  /** Grant a scoped, time-boxed authorization to a subject address (issue #302). */
  @Post()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_INCIDENTS)
  @HttpCode(HttpStatus.CREATED)
  grant(@Body() dto: GrantAuthorizationDto, @Req() req: AuthenticatedRequest): AuthorizationGrant {
    try {
      return this.authorizations.grant(dto.subjectAddress, dto.scope, req.user.walletAddress, dto.ttlMs);
    } catch (error) {
      toHttpError(error);
    }
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  get(@Param('id') id: string): AuthorizationGrant {
    try {
      return this.authorizations.get(id);
    } catch (error) {
      toHttpError(error);
    }
  }

  /** Renew a grant. The caller must be the original grantor or the grant's subject. */
  @Post(':id/renew')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  renew(
    @Param('id') id: string,
    @Body() dto: RenewAuthorizationDto,
    @Req() req: AuthenticatedRequest,
  ): AuthorizationGrant {
    try {
      return this.authorizations.renew(id, req.user.walletAddress, dto.ttlMs);
    } catch (error) {
      toHttpError(error);
    }
  }

  /** Revoke a grant. The caller must be its original grantor. */
  @Post(':id/revoke')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  revoke(@Param('id') id: string, @Req() req: AuthenticatedRequest): AuthorizationGrant {
    try {
      return this.authorizations.revoke(id, req.user.walletAddress);
    } catch (error) {
      toHttpError(error);
    }
  }

  /** Report/cleanup stale grants: transitions lapsed Active grants to Expired. Admin-only. */
  @Post('cleanup')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_INCIDENTS)
  @HttpCode(HttpStatus.OK)
  cleanup(): CleanupReport {
    return this.authorizations.cleanupExpired();
  }
}
