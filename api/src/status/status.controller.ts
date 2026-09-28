import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Permission } from '../auth/rbac';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { StatusService } from './status.service';
import { MaintenanceWindowRecord, StatusReport } from './status.interface';
import { ScheduleMaintenanceDto } from './dto/schedule-maintenance.dto';

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

  @Post('maintenance/:id/cancel')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_INCIDENTS)
  @HttpCode(HttpStatus.OK)
  cancelMaintenance(@Param('id') id: string): MaintenanceWindowRecord {
    return this.status.cancelMaintenance(id);
  }
}
