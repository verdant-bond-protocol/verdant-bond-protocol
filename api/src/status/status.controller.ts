import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Permission } from '../auth/rbac';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { StatusService } from './status.service';
import { ComponentStatus, MaintenanceWindowRecord, MaintenanceWindowStatus, StatusReport } from './status.interface';
import { ScheduleMaintenanceDto } from './dto/schedule-maintenance.dto';
import { ArchiveMaintenanceDto } from './dto/archive-maintenance.dto';

/** An admin-facing window: the record plus its derived schedule state. */
type MaintenanceWindowView = MaintenanceWindowRecord & { status: MaintenanceWindowStatus };

export class PauseProtocolDto {
  reason!: string;
}

export class SetComponentStatusDto {
  status!: ComponentStatus;
  notice?: string;
}

@ApiTags('status')
@Controller('status')
export class StatusController {
  constructor(private readonly status: StatusService) {}

  /** Public, unauthenticated status feed (issue #303 & #370). No guard: this is meant to be embeddable on a public status page. */
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

  /** Emergency operator command to pause all protocol state mutations. */
  @Post('pause')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_INCIDENTS)
  @HttpCode(HttpStatus.OK)
  pauseProtocol(
    @Body() dto: PauseProtocolDto,
    @Req() req: AuthenticatedRequest,
  ): { status: string; paused: boolean } {
    this.status.pauseProtocol(dto.reason, req.user.walletAddress);
    return { status: 'paused', paused: true };
  }

  /** Operator command to resume protocol mutations. */
  @Post('resume')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_INCIDENTS)
  @HttpCode(HttpStatus.OK)
  resumeProtocol(
    @Req() req: AuthenticatedRequest,
  ): { status: string; paused: boolean } {
    this.status.resumeProtocol(req.user.walletAddress);
    return { status: 'operational', paused: false };
  }

  /** Set individual component status override (e.g. degrade, pause, or place in maintenance). */
  @Post('component/:name')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_INCIDENTS)
  @HttpCode(HttpStatus.OK)
  setComponentStatus(
    @Param('name') name: string,
    @Body() dto: SetComponentStatusDto,
    @Req() req: AuthenticatedRequest,
  ): { component: string; status: ComponentStatus } {
    this.status.setComponentStatus(name, dto.status, dto.notice, req.user.walletAddress);
    return { component: name, status: dto.status };
  }

  /** Clear individual component status override. */
  @Delete('component/:name')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_INCIDENTS)
  @HttpCode(HttpStatus.OK)
  clearComponentOverride(
    @Param('name') name: string,
  ): { component: string; cleared: boolean } {
    this.status.clearComponentOverride(name);
    return { component: name, cleared: true };
  }
}
