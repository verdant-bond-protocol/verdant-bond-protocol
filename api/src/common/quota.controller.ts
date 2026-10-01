import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { QuotaService } from './services/quota.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { RequirePermissions } from './decorators/permissions.decorator';
import { Permission } from '../auth/rbac';

@Controller('quota')
export class QuotaController {
  constructor(private readonly quotaService: QuotaService) {}

  @Get('usage/:actorId')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_INCIDENTS) // Reusing maintainer/privileged permission
  async getQuotaUsage(@Param('actorId') actorId: string) {
    return this.quotaService.getAllUsageForActor(actorId);
  }
}
