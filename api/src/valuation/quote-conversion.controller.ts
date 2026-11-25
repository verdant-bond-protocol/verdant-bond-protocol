import { Body, Controller, Get, Headers, Param, Post, Request, UseGuards } from '@nestjs/common';
import { Permission } from '../auth/rbac';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { ConsumeQuoteDto, IssueQuoteDto } from './dto/quote-conversion.dto';
import { QuoteConversionService } from './quote-conversion.service';

@Controller('valuations/quotes')
export class QuoteConversionController {
  constructor(private readonly quoteService: QuoteConversionService) {}

  @Post()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.REQUEST_CONVERSION_QUOTE)
  @Idempotent()
  async issueQuote(
    @Body() dto: IssueQuoteDto,
    @Request() req: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const account = req.user?.walletAddress || req.user?.sub || dto.account || '';
    return this.quoteService.issueQuote({
      baseCurrency: dto.baseCurrency,
      quoteCurrency: dto.quoteCurrency,
      amount: dto.amount,
      account,
      purpose: dto.purpose,
      idempotencyKey,
    });
  }

  @Post(':id/consume')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.CONSUME_CONVERSION_QUOTE)
  @Idempotent()
  async consumeQuote(
    @Param('id') id: string,
    @Body() dto: ConsumeQuoteDto,
    @Request() req: any,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const account = req.user?.walletAddress || req.user?.sub || dto.account || '';
    return this.quoteService.consumeQuote({
      quoteId: id,
      account,
      purpose: dto.purpose,
      idempotencyKey,
    });
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(Permission.REQUEST_CONVERSION_QUOTE)
  getQuote(@Param('id') id: string) {
    return this.quoteService.getQuote(id);
  }
}
