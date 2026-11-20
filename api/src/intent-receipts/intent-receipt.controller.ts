import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { IntentReceiptService } from './intent-receipt.service';
import {
  IntentReceipt,
  IntentReceiptSigner,
  IntentReceiptStatus,
  IntentReceiptVerification,
  IntentReceiptView,
  ReviewDisposition,
} from './intent-receipt.types';

const STATUSES: IntentReceiptStatus[] = ['authorized', 'succeeded', 'failed', 'rejected'];

/**
 * Review surface for maintainer intent receipts. Read-only apart from
 * attaching reviews; receipts themselves are only ever created by IntentGuard
 * and finalised by IntentReceiptInterceptor.
 */
@Controller('admin/intent-receipts')
@UseGuards(JwtAuthGuard, AdminGuard)
export class IntentReceiptController {
  constructor(private readonly receipts: IntentReceiptService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('action') action?: string,
    @Query('target') target?: string,
    @Query('actor') actor?: string,
    @Query('stale') stale?: string,
    @Query('limit') limit?: string,
  ): IntentReceiptView[] {
    if (status && !STATUSES.includes(status as IntentReceiptStatus)) {
      throw new BadRequestException(`status must be one of: ${STATUSES.join(', ')}`);
    }
    return this.receipts.list({
      status: status as IntentReceiptStatus | undefined,
      action,
      target,
      actor,
      staleOnly: stale === 'true',
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('stats')
  stats() {
    return this.receipts.getStats();
  }

  @Get('signing-key')
  signingKey(): IntentReceiptSigner {
    return this.receipts.getSigner();
  }

  /** Verify a receipt exported earlier (e.g. attached to an incident ticket). */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verifyExported(@Body() receipt: IntentReceipt): Promise<IntentReceiptVerification> {
    if (!receipt || typeof receipt !== 'object' || typeof receipt.receiptId !== 'string') {
      throw new BadRequestException('A receipt object is required');
    }
    return this.receipts.verifyReceipt(receipt);
  }

  @Get(':id')
  get(@Param('id') id: string): IntentReceiptView {
    return this.receipts.get(id);
  }

  @Get(':id/verify')
  verify(@Param('id') id: string): Promise<IntentReceiptVerification> {
    return this.receipts.verify(id);
  }

  @Post(':id/reviews')
  @HttpCode(HttpStatus.CREATED)
  review(
    @Param('id') id: string,
    @Body() body: { disposition: ReviewDisposition; note: string },
    @Req() req: { user?: { walletAddress?: string } },
  ): Promise<IntentReceiptView> {
    return this.receipts.review(id, req.user?.walletAddress ?? 'unknown', body?.disposition, body?.note);
  }
}
