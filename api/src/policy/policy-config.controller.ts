import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { IntentGuard } from '../common/guards/intent.guard';
import { RequireIntent } from '../common/decorators/require-intent.decorator';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { PolicyConfigChangeDto, PolicyConfigRollbackDto } from './dto/policy-config-change.dto';
import {
  PolicyConfigChangeOutcome,
  PolicyConfigChangeService,
  PolicyConfigSnapshot,
} from './policy-config-change.service';

/**
 * Administrative policy configuration (#408). Admin-only; mutations also need
 * a signed step-up intent, like every other admin mutation. Evidence is read
 * through the existing audit API, served at
 * `/api/api/v1/audit/{history,verify,evidence}/admin-config/policy` (the audit
 * controller's own `api/v1` path stacks with the global `api` prefix).
 */
@ApiTags('admin-config')
@ApiBearerAuth()
@Controller('admin/config/policy')
@UseGuards(JwtAuthGuard, AdminGuard)
export class PolicyConfigController {
  constructor(private readonly changes: PolicyConfigChangeService) {}

  @Get()
  getConfiguration(): PolicyConfigSnapshot {
    return this.changes.getConfiguration();
  }

  @Put()
  @UseGuards(IntentGuard)
  @RequireIntent('update_policy_config', 'id', 'policy')
  updateConfiguration(@Body() dto: PolicyConfigChangeDto, @Req() req: AuthenticatedRequest): Promise<PolicyConfigChangeOutcome> {
    return this.changes.apply({ ...dto, actor: req.user.walletAddress });
  }

  @Post('rollback')
  @UseGuards(IntentGuard)
  @RequireIntent('rollback_policy_config', 'targetChangeId')
  @HttpCode(HttpStatus.OK)
  rollback(@Body() dto: PolicyConfigRollbackDto, @Req() req: AuthenticatedRequest): Promise<PolicyConfigChangeOutcome> {
    return this.changes.rollback({ ...dto, actor: req.user.walletAddress });
  }
}
