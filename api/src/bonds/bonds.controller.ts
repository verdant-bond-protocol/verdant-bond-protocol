import {
  Controller, Get, Post, Body, Param, Query, Req, HttpCode, HttpStatus, UseGuards, ParseIntPipe, Header, NotFoundException
} from '@nestjs/common';
import { BondsService } from './bonds.service';
import { CreateBondDto } from './dto/create-bond.dto';
import { SubscribeDto } from './dto/subscribe.dto';
import { DistributeCouponDto } from './dto/distribute-coupon.dto';
import { ClaimCreditsDto } from './dto/claim-credits.dto';
import { TransferBondDto } from './dto/transfer-bond.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { KycGuard } from '../common/guards/kyc.guard';
import { IntentGuard } from '../common/guards/intent.guard';
import { RequireIntent } from '../common/decorators/require-intent.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import {
  BondResponse,
  SubscriptionResponse,
  HolderListResponse,
  HeldBondResponse,
  CouponDistributionResponse,
  ClaimCreditsResponse,
  TransferResponse,
  UndistributedTotalResponse,
  SweepUndistributedResponse,
  BondDetailResponse,
  ClaimableCreditsResponse,
} from './interfaces/bond.interface';

@Controller('bonds')
export class BondsController {
  constructor(private readonly bondsService: BondsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, AdminGuard, IntentGuard)
  @RequireIntent('create_bond')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateBondDto): Promise<BondResponse> {
    return this.bondsService.create(dto);
  }

  @Get()
  async findAll(@Query() query: PaginationDto) {
    return this.bondsService.findAll(query.page, query.limit);
  }

  @Get('held/:address')
  async findHeldByAddress(
    @Param('address') address: string,
  ): Promise<HeldBondResponse[]> {
    return this.bondsService.findHeldByAddress(address);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-cache')
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<BondResponse> {
    return this.bondsService.findOne(id);
  }

  @Get(':id/detail')
  @Header('Cache-Control', 'no-cache')
  async getBondDetail(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<BondDetailResponse> {
    return this.bondsService.getBondDetail(id);
  }

  @Post(':id/subscribe')
  @UseGuards(JwtAuthGuard, KycGuard)
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async subscribe(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubscribeDto,
  ): Promise<SubscriptionResponse> {
    return this.bondsService.subscribe(id, dto);
  }

  @Get(':id/holders')
  async getHolders(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<HolderListResponse> {
    return this.bondsService.getHolders(id);
  }

  @Post(':id/coupon')
  @UseGuards(JwtAuthGuard, AdminGuard, IntentGuard)
  @RequireIntent('distribute_coupon')
  @HttpCode(HttpStatus.OK)
  async distributeCoupon(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DistributeCouponDto,
  ): Promise<CouponDistributionResponse> {
    return this.bondsService.distributeCoupon(id, dto);
  }

  @Post(':id/claim')
  @UseGuards(JwtAuthGuard, KycGuard)
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async claimCredits(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ClaimCreditsDto,
  ): Promise<ClaimCreditsResponse> {
    return this.bondsService.claimCredits(id, dto);
  }

  @Get(':id/undistributed')
  async getUndistributedTotal(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<UndistributedTotalResponse> {
    return this.bondsService.getUndistributedTotal(id);
  }

  @Get(':id/claimable-credits')
  @Header('Cache-Control', 'no-cache')
  async getClaimableCredits(
    @Param('id', ParseIntPipe) id: number,
    @Query('address') address?: string,
  ): Promise<ClaimableCreditsResponse> {
    return this.bondsService.getClaimableCreditDetails(id, address);
  }

  @Post(':id/sweep-undistributed')
  @UseGuards(JwtAuthGuard, AdminGuard, IntentGuard)
  @RequireIntent('sweep_undistributed')
  @RateLimit({ type: 'mutation' })
  @HttpCode(HttpStatus.OK)
  async sweepUndistributed(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<SweepUndistributedResponse> {
    return this.bondsService.sweepUndistributed(id);
  }

  @Post(':id/transfer')
  @UseGuards(JwtAuthGuard, KycGuard)
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  async transfer(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TransferBondDto,
  ): Promise<TransferResponse> {
    return this.bondsService.transfer(id, dto);
  }

  /**
   * Operational repair (#117): reconcile the authoritative holder index for a
   * single bond against on-chain balances. Discovers out-of-band transfers.
   */
  @Post(':id/reconcile-holders')
  @UseGuards(JwtAuthGuard, AdminGuard, IntentGuard)
  @RequireIntent('reconcile_holders')
  @HttpCode(HttpStatus.OK)
  async reconcileHolders(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<HolderListResponse> {
    return this.bondsService.reconcileBond(id);
  }

  /**
   * Operational repair (#117): reindex every bond's holders against on-chain
   * balances. Run after Redis loss or suspected direct contract transfers.
   */
  @Post('admin/reindex-holders')
  @UseGuards(JwtAuthGuard, AdminGuard, IntentGuard)
  @RequireIntent('reindex_holders', 'id', 'global')
  @HttpCode(HttpStatus.OK)
  async reindexHolders(): Promise<Array<{ bondId: number; total: number }>> {
    return this.bondsService.reindexHolders();
  }

  @Post(':id/mature')
  @UseGuards(JwtAuthGuard, AdminGuard, IntentGuard)
  @RequireIntent('mature_bond')
  @HttpCode(HttpStatus.OK)
  async mature(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<BondResponse> {
    return this.bondsService.mature(id);
  }

  @Get(':id/export')
  @UseGuards(JwtAuthGuard)
  async exportBond(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
  ): Promise<any> {
    const auditorAddress = req.user?.walletAddress || '';
    return this.bondsService.exportBond(id, auditorAddress);
  }
}
