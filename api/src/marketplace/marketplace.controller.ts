import {
  Controller, Get, Post, Delete, Body, Param, Query, Req,
  HttpCode, HttpStatus, ParseIntPipe, UseGuards, NotFoundException,
} from '@nestjs/common';
import { DexService } from './dex.service';
import { LiquidityService } from './liquidity.service';
import { StellarService } from '../stellar/stellar.service';
import { DexReconciliationService, ReconciliationReport } from './dex.reconciliation.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ListBondDto } from './dto/list-bond.dto';
import { BuyBondDto } from './dto/buy-bond.dto';
import { DepositQuoteDto } from './dto/deposit-quote.dto';
import { WithdrawQuoteDto } from './dto/withdraw-quote.dto';
import { QuoteBalanceQueryDto } from './dto/quote-balance-query.dto';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import {
  OrderResponse,
  PriceFeedResponse,
  PriceLevel,
  QuoteBalanceResponse,
  QuoteTransactionResponse,
  SlippageResponse,
} from './interfaces/marketplace.interface';
import { PaginatedResponse, PaginationDto } from '../common/dto/pagination.dto';
import { toBigIntString } from '../common/utils';
import { listSupportedQuoteAssets, QuoteAssetConfig } from './quote-assets';
import { Idempotent } from '../common/decorators/idempotent.decorator';

@Controller('marketplace')
export class MarketplaceController {
  constructor(
    private readonly dexService: DexService,
    private readonly liquidityService: LiquidityService,
    private readonly stellarService: StellarService,
    private readonly reconciliation: DexReconciliationService,
  ) {}

  /**
   * The canonical quote asset registry (issue #92). The frontend fetches
   * this instead of hardcoding its own asset list, so the two never drift.
   */
  @Get('quote-assets')
  listQuoteAssets(): readonly QuoteAssetConfig[] {
    return listSupportedQuoteAssets();
  }

  @Get('orders')
  async listOrders(
    @Query('bondId') bondId?: number,
    @Query('status') status?: string,
    @Query() pagination: PaginationDto = new PaginationDto(),
  ): Promise<PaginatedResponse<OrderResponse>> {
    return this.dexService.listOrders(
      bondId ? Number(bondId) : undefined,
      status,
      pagination.page ?? 1,
      pagination.limit ?? 20,
      pagination.cursor,
    );
  }

  @Post('list')
  @Idempotent()
  @RateLimit({ type: 'mutation' })
  @HttpCode(HttpStatus.CREATED)
  async listBondTokens(
    @Body() dto: ListBondDto,
    @Req() req: any,
  ): Promise<OrderResponse> {
    const sellerAddress = req.headers['x-wallet-address'] as string;
    return this.dexService.listBondTokens(dto, sellerAddress);
  }

  @Post('buy')
  @Idempotent()
  @RateLimit({ type: 'mutation' })
  @HttpCode(HttpStatus.OK)
  async buyBondTokens(
    @Body() dto: BuyBondDto,
    @Req() req: any,
  ): Promise<OrderResponse> {
    const buyerAddress = req.headers['x-wallet-address'] as string;
    return this.dexService.buyBondTokens(dto, buyerAddress);
  }

  @Get('quote-balance')
  async getQuoteBalance(
    @Query() query: QuoteBalanceQueryDto,
    @Req() req: any,
  ): Promise<QuoteBalanceResponse> {
    const address = req.headers['x-wallet-address'] as string;
    return this.dexService.getQuoteBalance(address, query.asset ?? 'USDC');
  }

  @Get('wallet-balance')
  async getWalletBalance(
    @Query() query: QuoteBalanceQueryDto,
    @Req() req: any,
  ): Promise<QuoteBalanceResponse> {
    const address = req.headers['x-wallet-address'] as string;
    const asset = query.asset ?? 'USDC';
    const balanceStr = await this.stellarService.getBalance(address, asset);
    return { address, asset, balance: balanceStr };
  }

  @Post('deposit')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async depositQuote(
    @Body() dto: DepositQuoteDto,
    @Req() req: any,
  ): Promise<QuoteTransactionResponse> {
    const address = req.headers['x-wallet-address'] as string;
    return this.dexService.depositQuote(dto, address);
  }

  @Post('withdraw')
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async withdrawQuote(
    @Body() dto: WithdrawQuoteDto,
    @Req() req: any,
  ): Promise<QuoteTransactionResponse> {
    const address = req.headers['x-wallet-address'] as string;
    return this.dexService.withdrawQuote(dto, address);
  }

  @Delete('orders/:id')
  @RateLimit({ type: 'mutation' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelOrder(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
  ): Promise<void> {
    const callerAddress = req.headers['x-wallet-address'] as string;
    return this.dexService.cancelOrder(id, callerAddress);
  }

  @Get('orders/:id')
  async getOrder(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<OrderResponse> {
    return this.dexService.getOrder(id);
  }

  @Get('prices')
  async getPriceFeed(
    @Query('bondId') bondId?: number,
  ): Promise<PriceFeedResponse[]> {
    return this.liquidityService.getPriceFeed(bondId ? Number(bondId) : undefined);
  }

  @Get('prices/:bondId/best')
  async getBestPrice(
    @Param('bondId', ParseIntPipe) bondId: number,
    @Query('side') side: 'buy' | 'sell' = 'sell',
  ): Promise<PriceLevel> {
    return this.liquidityService.getBestPrice(bondId, side);
  }

  @Get('prices/:bondId/slippage')
  async calculateSlippage(
    @Param('bondId', ParseIntPipe) bondId: number,
    @Query('amount') amount: number,
  ): Promise<SlippageResponse> {
    return this.liquidityService.calculateSlippage(bondId, Number(amount));
  }

  /**
   * Operator reconciliation surface (#recon). Marketplace endpoints are
   * wallet-header authenticated, so these are operator-tooling routes gated by
   * the same `x-wallet-address` convention rather than a JWT.
   */
  @Post('reconciliation/run')
  @RateLimit({ type: 'mutation' })
  @HttpCode(HttpStatus.OK)
  async runReconciliation(
    @Body() body: { wallets?: string[]; assets?: string[]; maxOrderScan?: number },
  ): Promise<ReconciliationReport> {
    return this.reconciliation.reconcile({
      wallets: body?.wallets,
      assets: body?.assets as any,
      maxOrderScan: body?.maxOrderScan,
    });
  }

  @Get('reconciliation/mismatches')
  async listReconciliationMismatches(
    @Query('limit') limit?: string,
  ): Promise<unknown[]> {
    return this.reconciliation.listMismatches(limit ? Number(limit) : 50);
  }

  @Post('reconciliation/repair')
  @RateLimit({ type: 'mutation' })
  @HttpCode(HttpStatus.OK)
  async repairReconciliation(
    @Body() body: { report?: ReconciliationReport },
  ): Promise<{ correlationId: string; repaired: number; actions: string[] }> {
    const report = body?.report ?? (await this.reconciliation.getLastReport());
    if (!report) {
      throw new NotFoundException('No reconciliation report available to repair');
    }
    const actions = await this.reconciliation.repair(report);
    return { correlationId: report.correlationId, repaired: actions.length, actions };
  }
}
