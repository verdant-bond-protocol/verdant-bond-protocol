import { Controller, Get, Query, Request, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Permission, Role } from '../../auth/rbac';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { KycStatus } from '../../common/interfaces/authenticated-request.interface';
import {
  InvestorExportFormat,
  InvestorExportPurpose,
} from '../interfaces/investor-compliance-export.interface';
import { InvestorComplianceExportService } from '../services/investor-compliance-export.service';

@Controller('api/v1/exports/investors')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.EXPORT_INVESTOR_COMPLIANCE)
export class InvestorComplianceExportController {
  constructor(private readonly exportService: InvestorComplianceExportService) {}

  @Get('compliance')
  @RateLimit({ points: 10, durationSeconds: 60, keyPrefix: 'investor-compliance-export' })
  async exportCompliance(
    @Request() req: any,
    @Res() res: Response,
    @Query('format') format: InvestorExportFormat = 'csv',
    @Query('purpose') purpose: InvestorExportPurpose = 'compliance_reporting',
    @Query('asOf') asOf?: string,
    @Query('includeWallet') includeWallet?: string,
    @Query('bondId') bondId?: string,
    @Query('jurisdiction') jurisdiction?: string,
    @Query('kycStatus') kycStatus?: KycStatus,
  ): Promise<void> {
    const requesterId = req.user?.walletAddress || req.user?.sub || 'unknown';
    const requesterRoles: Role[] = Array.isArray(req.user?.roles) ? req.user.roles : [];

    res.setHeader(
      'Content-Type',
      format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
    );
    res.setHeader('Cache-Control', 'no-store');

    const stream = this.exportService.streamExport({
      requesterId,
      requesterRoles,
      purpose,
      format,
      asOfTimestamp: asOf,
      includeWalletAddress: includeWallet === 'true',
      filters: {
        bondId: bondId ? parseInt(bondId, 10) : undefined,
        jurisdiction,
        kycStatus,
      },
    });

    for await (const chunk of stream) {
      res.write(chunk, 'utf8');
    }
    res.end();
  }
}
