import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FeesService } from './fees.service';
import { FeePreviewDto } from './dto/fee-preview.dto';
import { FeeBreakdown } from './fee-calculation';

@ApiTags('fees')
@ApiBearerAuth()
@Controller('fees')
export class FeesController {
  constructor(private readonly fees: FeesService) {}

  /**
   * Preview the fee breakdown for a candidate amount before final submission
   * (issue #301). Read-only: nothing is charged or recorded by this call.
   */
  @Post('preview')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  preview(@Body() dto: FeePreviewDto): FeeBreakdown {
    return this.fees.preview(dto.amountMinorUnits, dto.asset, dto.scheduleName ?? 'subscription');
  }
}
