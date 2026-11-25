import { Injectable } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiProblemException } from '../common/errors/problem-exception';
import { CurrencyRateSource, RateSample } from './quote-conversion.interface';

interface StaticPairRate {
  rateNumerator: string;
  rateDenominator: string;
  scale: number;
}

const DEFAULT_PAIRS: Record<string, StaticPairRate> = {
  'USD:XLM': { rateNumerator: '83333333', rateDenominator: '10000000', scale: 7 },
  'XLM:USD': { rateNumerator: '1200000', rateDenominator: '10000000', scale: 7 },
  'EUR:USDC': { rateNumerator: '10800000', rateDenominator: '10000000', scale: 7 },
  'USDC:EUR': { rateNumerator: '9259259', rateDenominator: '10000000', scale: 7 },
  'USDC:XLM': { rateNumerator: '83333333', rateDenominator: '10000000', scale: 7 },
  'XLM:USDC': { rateNumerator: '1200000', rateDenominator: '10000000', scale: 7 },
};

/**
 * Deterministic rate source for local development and tests.
 *
 * NOTE: No live FX or Stellar DEX orderbook rate feed is wired in this
 * vertical slice. Replace or override `CURRENCY_RATE_SOURCE` with a live
 * adapter before enabling production cross-currency settlement.
 */
@Injectable()
export class StaticTestRateSource implements CurrencyRateSource {
  readonly id = 'static-test-rate-source';
  private readonly overrides = new Map<string, RateSample>();

  setRate(sample: RateSample): void {
    this.overrides.set(`${sample.baseCurrency.toUpperCase()}:${sample.quoteCurrency.toUpperCase()}`, sample);
  }

  clearOverrides(): void {
    this.overrides.clear();
  }

  async getRate(baseCurrency: string, quoteCurrency: string): Promise<RateSample> {
    const base = baseCurrency.trim().toUpperCase();
    const quote = quoteCurrency.trim().toUpperCase();
    const key = `${base}:${quote}`;

    const override = this.overrides.get(key);
    if (override) {
      return override;
    }

    if (base === quote) {
      return {
        baseCurrency: base,
        quoteCurrency: quote,
        rateNumerator: '1',
        rateDenominator: '1',
        scale: 7,
        referenceRateNumerator: '1',
        referenceRateDenominator: '1',
        source: this.id,
        observedAt: new Date(),
      };
    }

    const pair = DEFAULT_PAIRS[key];
    if (!pair) {
      throw new ApiProblemException(ErrorCode.VALIDATION_FAILED, {
        detail: `Unsupported currency pair ${base}/${quote}`,
      });
    }

    return {
      baseCurrency: base,
      quoteCurrency: quote,
      rateNumerator: pair.rateNumerator,
      rateDenominator: pair.rateDenominator,
      scale: pair.scale,
      referenceRateNumerator: pair.rateNumerator,
      referenceRateDenominator: pair.rateDenominator,
      source: this.id,
      observedAt: new Date(),
    };
  }
}
