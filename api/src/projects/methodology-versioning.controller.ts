import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { Permission } from '../auth/rbac';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import {
  CreateMethodologyVersionDto,
  DeprecateMethodologyDto,
  MigrateLegacyMethodologyDto,
  PinBondMethodologyDto,
  RecordReportMethodologyDto,
} from './dto/methodology-version.dto';
import { MethodologyVersioningService } from './methodology-versioning.service';

@Controller('methodologies')
export class MethodologyVersioningController {
  constructor(private readonly methodologyService: MethodologyVersioningService) {}

  @Post()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_METHODOLOGIES)
  createDraft(@Body() dto: CreateMethodologyVersionDto, @Request() req: any) {
    const actor = req.user?.walletAddress || req.user?.sub || 'unknown';
    return this.methodologyService.createDraft({ ...dto, actor });
  }

  @Post(':id/versions/:version/activate')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_METHODOLOGIES)
  activate(
    @Param('id') id: string,
    @Param('version') version: string,
    @Request() req: any,
  ) {
    const actor = req.user?.walletAddress || req.user?.sub || 'unknown';
    return this.methodologyService.activateVersion(id, version, actor);
  }

  @Post(':id/versions/:version/deprecate')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_METHODOLOGIES)
  deprecate(
    @Param('id') id: string,
    @Param('version') version: string,
    @Body() dto: DeprecateMethodologyDto,
    @Request() req: any,
  ) {
    const actor = req.user?.walletAddress || req.user?.sub || 'unknown';
    return this.methodologyService.deprecateVersion(id, version, actor, dto.reason);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  list(@Query('methodologyId') methodologyId?: string) {
    return this.methodologyService.listVersions(methodologyId);
  }

  @Get(':id/versions/:version')
  @UseGuards(JwtAuthGuard)
  getOne(@Param('id') id: string, @Param('version') version: string) {
    return this.methodologyService.getVersion(id, version);
  }

  @Post('bonds/:bondId/pin')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_METHODOLOGIES)
  pinToBond(
    @Param('bondId', ParseIntPipe) bondId: number,
    @Body() dto: PinBondMethodologyDto,
    @Request() req: any,
  ) {
    const actor = req.user?.walletAddress || req.user?.sub || 'unknown';
    return this.methodologyService.pinMethodologyToBond(bondId, dto.methodologyId, dto.version, actor);
  }

  @Get('bonds/:bondId/pin')
  @UseGuards(JwtAuthGuard)
  getBondPin(@Param('bondId', ParseIntPipe) bondId: number) {
    return this.methodologyService.getBondPin(bondId);
  }

  @Post('reports/:reportId/bind')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_METHODOLOGIES)
  bindReport(
    @Param('reportId', ParseIntPipe) reportId: number,
    @Body() dto: RecordReportMethodologyDto,
    @Request() req: any,
  ) {
    const actor = req.user?.walletAddress || req.user?.sub || 'unknown';
    return this.methodologyService.recordReportMethodology({ ...dto, reportId, actor });
  }

  @Post('migrations/legacy')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_METHODOLOGIES)
  migrateLegacy(@Body() dto: MigrateLegacyMethodologyDto, @Request() req: any) {
    const actor = req.user?.walletAddress || req.user?.sub || 'unknown';
    return this.methodologyService.migrateLegacyBondsAndReports(dto.bondIds, dto.reports, actor);
  }

  @Post('migrations/legacy/rollback')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.MANAGE_METHODOLOGIES)
  rollbackLegacy(@Request() req: any) {
    const actor = req.user?.walletAddress || req.user?.sub || 'unknown';
    return this.methodologyService.rollbackLegacyMigration(actor);
  }
}
