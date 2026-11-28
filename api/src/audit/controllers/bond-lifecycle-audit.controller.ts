import { Controller, Get, Param, ParseIntPipe, Query, Req, UseGuards } from '@nestjs/common';
import { BondLifecycleAuditBundleService } from './bond-lifecycle-audit-bundle.service';
import { BondLifecycleBundle } from './bond-lifecycle-bundle-core';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('api/v1/audit/bond-lifecycle')
@UseGuards(JwtAuthGuard, AdminGuard)
export class BondLifecycleAuditController {
  constructor(private readonly bundles: BondLifecycleAuditBundleService) {}

  @Get(':bondId')
  async bundle(
    @Param('bondId', ParseIntPipe) bondId: number,
    @Query('caseId') caseId: string,
    @Query('asOf') asOf: string,
    @Req() req: { user?: { walletAddress?: string } },
  ): Promise<BondLifecycleBundle> {
    return this.bundles.build(bondId, caseId, asOf, req.user?.walletAddress ?? '');
  }
}
