import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { PayoutRedemptionFailureInjectionService } from './payout-redemption-failure-injection.service';
import {
  CreateInjectionRuleDto,
  FinancialInvariants,
  FlowType,
  InjectionRule,
  SimulationResult,
} from './failure-injection.interface';

@Controller('api/v1/operations/failures/injection')
@UseGuards(JwtAuthGuard, AdminGuard)
export class FailureInjectionController {
  constructor(private readonly injectionService: PayoutRedemptionFailureInjectionService) {}

  @Get('rules')
  listRules(@Query('flowType') flowType?: FlowType): InjectionRule[] {
    return this.injectionService.listRules(flowType);
  }

  @Post('rules')
  @HttpCode(HttpStatus.CREATED)
  createRule(
    @Body() dto: CreateInjectionRuleDto,
    @Req() req: AuthenticatedRequest,
  ): InjectionRule {
    return this.injectionService.registerRule(dto, req.user.walletAddress);
  }

  @Delete('rules/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteRule(@Param('id') id: string): void {
    this.injectionService.removeRule(id);
  }

  @Get('invariants')
  getInvariants(): FinancialInvariants {
    return this.injectionService.getFinancialInvariants();
  }

  @Post('simulate/payout')
  @HttpCode(HttpStatus.OK)
  simulatePayout(
    @Body()
    body: {
      bondId: number;
      amount: string;
      recipientAddress: string;
      idempotencyKey?: string;
    },
    @Req() req: AuthenticatedRequest,
  ): Promise<SimulationResult> {
    return this.injectionService.simulatePayoutFlow({
      bondId: body.bondId,
      amount: BigInt(body.amount),
      recipientAddress: body.recipientAddress,
      callerRole: req.user.roles?.[0] || 'maintainer',
      idempotencyKey: body.idempotencyKey || `sim_payout_${Date.now()}`,
    });
  }

  @Post('simulate/redemption')
  @HttpCode(HttpStatus.OK)
  simulateRedemption(
    @Body()
    body: {
      bondId: number;
      amount: string;
      holderAddress: string;
      idempotencyKey?: string;
    },
  ): Promise<SimulationResult> {
    return this.injectionService.simulateRedemptionFlow({
      bondId: body.bondId,
      amount: BigInt(body.amount),
      holderAddress: body.holderAddress,
      idempotencyKey: body.idempotencyKey || `sim_redemption_${Date.now()}`,
    });
  }
}
