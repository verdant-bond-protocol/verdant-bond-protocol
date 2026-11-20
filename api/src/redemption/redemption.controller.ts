import { Controller, Post, Body, BadRequestException, Logger } from '@nestjs/common';
import { RedemptionService } from './redemption.service';
import {
  EarlyRedemptionRequest,
  RedemptionPayout,
  SolvencyCheck,
  TrancheProtection,
} from './redemption.interface';

@Controller('redemption')
export class RedemptionController {
  private readonly logger = new Logger(RedemptionController.name);

  constructor(private readonly redemptionService: RedemptionService) {}

  @Post('evaluate')
  async evaluateRedemption(@Body() request: EarlyRedemptionRequest): Promise<RedemptionPayout> {
    if (!request.bondId || !request.investorAddress || !request.amount) {
      throw new BadRequestException('Missing required fields: bondId, investorAddress, amount');
    }

    try {
      return await this.redemptionService.evaluateEarlyRedemption(request);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error('Error evaluating redemption', error);
      throw new BadRequestException('Failed to evaluate redemption');
    }
  }

  @Post('check-solvency')
  async checkSolvency(
    @Body() body: { bondId: number; amount: string },
  ): Promise<SolvencyCheck> {
    if (!body.bondId || !body.amount) {
      throw new BadRequestException('Missing required fields: bondId, amount');
    }

    try {
      return await this.redemptionService.checkSolvencyForRedemption(body.bondId, body.amount);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error('Error checking solvency', error);
      throw new BadRequestException('Failed to check bond solvency');
    }
  }

  @Post('verify-tranche')
  async verifyTranche(
    @Body() body: { bondId: number; amount: string },
  ): Promise<TrancheProtection> {
    if (!body.bondId || !body.amount) {
      throw new BadRequestException('Missing required fields: bondId, amount');
    }

    try {
      return await this.redemptionService.verifyTrancheProtection(body.bondId, body.amount);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error('Error verifying tranche protection', error);
      throw new BadRequestException('Failed to verify tranche protection');
    }
  }
}
