import { Module } from '@nestjs/common';
import { HttpPriceSource } from './http-price.source';
import { VALUATION_CONFIG, ValuationConfig, loadValuationConfig } from './valuation.config';
import { ValuationController } from './valuation.controller';
import { CREDIT_PRICE_SOURCES, ValuationService } from './valuation.service';
import { CURRENCY_RATE_SOURCE } from './quote-conversion.interface';
import { StaticTestRateSource } from './static-rate.source';
import { QuoteConversionService } from './quote-conversion.service';
import { QuoteConversionController } from './quote-conversion.controller';

@Module({
  controllers: [ValuationController, QuoteConversionController],
  providers: [
    { provide: VALUATION_CONFIG, useFactory: () => loadValuationConfig() },
    {
      provide: CREDIT_PRICE_SOURCES,
      useFactory: (config: ValuationConfig) => config.feeds.map((feed) => new HttpPriceSource(feed)),
      inject: [VALUATION_CONFIG],
    },
    ValuationService,
    StaticTestRateSource,
    { provide: CURRENCY_RATE_SOURCE, useExisting: StaticTestRateSource },
    QuoteConversionService,
  ],
  exports: [ValuationService, QuoteConversionService],
})
export class ValuationModule {}
