import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Permission } from '../auth/rbac';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { StatusService } from './status.service';
import { MaintenanceWindowRecord, MaintenanceWindowStatus, StatusReport } from './status.interface';
import { ScheduleMaintenanceDto } from './dto/schedule-maintenance.dto';
import { ArchiveMaintenanceDto } from './dto/archive-maintenance.dto';

/** An admin-facing window: the record plus its derived schedule state. */
type MaintenanceWindowView = MaintenanceWindowRecord & { status: MaintenanceWindowStatus };

@ApiTags('status')
@Controller('status')
export class StatusController {
  constructor(private readonly status: StatusService) {}

  /** Public, unauthenticated status feed (issue #303). No guard: this is meant to be embeddable on a public status page. */
  @Get()
  getStatus(): Promise<StatusReport> {
    return this.status.getPublicStatus();
  }

  @Post('maintenance')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_INCIDENTS)
  @HttpCode(HttpStatus.CREATED)
  scheduleMaintenance(
    @Body() dto: ScheduleMaintenanceDto,
    @Req() req: AuthenticatedRequest,
  ): MaintenanceWindowRecord {
    return this.status.scheduleMaintenance(dto.title, dto.startsAt, dto.endsAt, req.user.walletAddress);
  }

  /**
   * Every window, including archived ones when `?includeArchived=true`, so an
   * operator can see what was withdrawn and why. The public feed never
   * includes archived windows.
   */
  @Get('maintenance')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_INCIDENTS)
  listMaintenance(
    @Query('includeArchived') includeArchived?: string,
  ): MaintenanceWindowView[] {
    return this.status.listMaintenance({ includeArchived: includeArchived === 'true' });
  }

  /** Withdraw a window by archiving it. A reason is mandatory. */
  @Post('maintenance/:id/archive')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_INCIDENTS)
  @HttpCode(HttpStatus.OK)
  archiveMaintenance(
    @Param('id') id: string,
    @Body() dto: ArchiveMaintenanceDto,
    @Req() req: AuthenticatedRequest,
  ): MaintenanceWindowRecord {
    return this.status.archiveMaintenance(id, req.user.walletAddress, dto.reason);
  }

  /** Re-publish a withdrawn window. The archive stays in its history. */
  @Post('maintenance/:id/restore')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_INCIDENTS)
  @HttpCode(HttpStatus.OK)
  restoreMaintenance(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): MaintenanceWindowRecord {
    return this.status.restoreMaintenance(id, req.user.walletAddress);
  }
}
