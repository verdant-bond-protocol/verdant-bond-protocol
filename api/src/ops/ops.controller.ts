import { Controller, Get, UseGuards } from '@nestjs/common';
import { OpsService } from './ops.service';
import { OpsDashboardResponse } from './interfaces/ops-dashboard.interface';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('ops')
export class OpsController {
  constructor(private readonly opsService: OpsService) {}

  @Get('dashboard')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async getDashboard(): Promise<OpsDashboardResponse> {
    return this.opsService.getDashboard();
  }
}
