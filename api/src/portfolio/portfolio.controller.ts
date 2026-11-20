import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PortfolioService } from './portfolio.service';

@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  /**
   * Wallet-scoped aggregate view (#116). A non-admin may only read their own
   * portfolio; admins may pass `address` to inspect any wallet.
   */
  @Get()
  @UseGuards(JwtAuthGuard)
  async getPortfolio(
    @Query('address') address: string,
    @Query('force') force: string,
    @Req() req: any,
  ): Promise<any> {
    const requester = req.user?.walletAddress;
    if (!requester) {
      throw new ForbiddenException('Authenticated wallet required');
    }

    const target = address || requester;
    const isAdmin = requester === process.env.STELLAR_PUBLIC_KEY;
    if (target !== requester && !isAdmin) {
      throw new ForbiddenException('You may only view your own portfolio');
    }

    return this.portfolioService.getPortfolio(target, { force: force === 'true' });
  }
}
