import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { BondsModule } from './bonds/bonds.module';
import { ProjectsModule } from './projects/projects.module';
import { OracleModule } from './oracle/oracle.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { AuthModule } from './auth/auth.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { StellarModule } from './stellar/stellar.module';
import { SeedModule } from './seed/seed.module';
import { ConfigModule } from './config/config.module';
import { ValuationModule } from './valuation/valuation.module';
import { Rfc7807ExceptionFilter } from './common/filters/rfc7807-exception.filter';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';

@Module({
  imports: [
    CommonModule,
    ConfigModule,
    BondsModule,
    ProjectsModule,
    OracleModule,
    MarketplaceModule,
    AuthModule,
    PortfolioModule,
    StellarModule,
    SeedModule,
    ValuationModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: Rfc7807ExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
