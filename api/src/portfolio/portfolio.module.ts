import { Module } from '@nestjs/common';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';
import { BondsModule } from '../bonds/bonds.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';

@Module({
  imports: [BondsModule, MarketplaceModule],
  controllers: [PortfolioController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
