import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { Permission } from '../../auth/rbac';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { Quota } from '../../common/decorators/quota.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { QuotaResource } from '../../common/services/quota.service';
import {
  CreateAdjustmentInput,
  PayoutReconciliationService,
  RunPayoutReconciliationInput,
} from '../services/payout-reconciliation.service';

@Controller('api/v1/reconciliation/payouts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.RECONCILE_PAYOUTS)
export class PayoutReconciliationController {
  constructor(private readonly payoutReconciliation: PayoutReconciliationService) {}

  @Post('run')
  @Quota(QuotaResource.RECONCILE_PAYOUTS)
  run(@Body() body: RunPayoutReconciliationInput) {
    return this.payoutReconciliation.reconcilePeriod(body);
  }

  @Get('reports/:runId')
  getReport(@Param('runId') runId: string) {
    return this.payoutReconciliation.getReport(runId);
  }

  @Post('adjustments')
  createAdjustment(@Body() body: Omit<CreateAdjustmentInput, 'actor'>, @Request() req: any) {
    const actor = req.user?.walletAddress || req.user?.sub || 'unknown';
    return this.payoutReconciliation.createAdjustment({ ...body, actor });
  }

  @Get('adjustments')
  listAdjustments(@Query('runId') runId?: string) {
    return this.payoutReconciliation.listAdjustments(runId);
  }
}
