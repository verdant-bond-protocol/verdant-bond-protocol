import { Module } from '@nestjs/common';
import { HttpPriceSource } from './http-price.source';
import { VALUATION_CONFIG, ValuationConfig, loadValuationConfig } from './valuation.config';
import { ValuationController } from './valuation.controller';
import { CREDIT_PRICE_SOURCES, ValuationService } from './valuation.service';

@Module({
  controllers: [ValuationController],
  providers: [
    { provide: VALUATION_CONFIG, useFactory: () => loadValuationConfig() },
    {
      provide: CREDIT_PRICE_SOURCES,
      useFactory: (config: ValuationConfig) => config.feeds.map((feed) => new HttpPriceSource(feed)),
      inject: [VALUATION_CONFIG],
    },
    ValuationService,
  ],
  exports: [ValuationService],
})
export class ValuationModule {}
