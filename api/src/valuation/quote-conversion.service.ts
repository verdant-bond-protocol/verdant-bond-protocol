import { ConflictException, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiProblemException } from '../common/errors/problem-exception';
import {
  ConsumeQuoteInput,
  ConversionExecutionResult,
  ConversionQuote,
  CURRENCY_RATE_SOURCE,
  CurrencyRateSource,
  IssueQuoteInput,
  QUOTE_CONVERSION_CONFIG,
  QuoteConversionConfig,
  RateSample,
} from './quote-conversion.interface';

export const DEFAULT_QUOTE_CONVERSION_CONFIG: QuoteConversionConfig = {
  ttlMs: Number(process.env.QUOTE_TTL_MS || 30_000),
  maxRateAgeMs: Number(process.env.QUOTE_MAX_RATE_AGE_MS || 60_000),
  maxSlippageBps: Number(process.env.QUOTE_MAX_SLIPPAGE_BPS || 100),
  maxAmountMinorUnits: 10n ** 18n,
  maxRateValue: 10n ** 15n,
};

interface IdempotencyEntry<T> {
  fingerprint: string;
  value: T;
}

@Injectable()
export class QuoteConversionService {
  private readonly quotes = new Map<string, ConversionQuote>();
  private readonly inFlightQuotes = new Set<string>();
  private readonly issueIdempotency = new Map<string, IdempotencyEntry<ConversionQuote>>();
  private readonly consumeIdempotency = new Map<string, IdempotencyEntry<ConversionExecutionResult>>();
  private readonly config: QuoteConversionConfig;

  constructor(
    @Inject(CURRENCY_RATE_SOURCE) private readonly rateSource: CurrencyRateSource,
    @Optional() @Inject(QUOTE_CONVERSION_CONFIG) config?: Partial<QuoteConversionConfig>,
  ) {
    this.config = { ...DEFAULT_QUOTE_CONVERSION_CONFIG, ...(config ?? {}) };
  }

  /**
   * Issue a short-lived, account- and purpose-bound conversion quote.
   * Rounding rule: floor `(amount * rateNumerator) / rateDenominator` so
   * conversions never create money; remainder `dust` is recorded explicitly.
   */
  async issueQuote(input: IssueQuoteInput): Promise<ConversionQuote> {
    const baseCurrency = this.normalizeCurrency(input.baseCurrency, 'baseCurrency');
    const quoteCurrency = this.normalizeCurrency(input.quoteCurrency, 'quoteCurrency');
    const account = this.normalizeNonEmpty(input.account, 'account');
    const amountBig = this.parsePositiveBoundedBigInt(
      input.amount,
      'amount',
      this.config.maxAmountMinorUnits,
    );

    const fingerprint = this.fingerprint({
      op: 'issue',
      baseCurrency,
      quoteCurrency,
      amount: amountBig.toString(),
      account,
      purpose: input.purpose,
    });

    if (input.idempotencyKey) {
      const cached = this.issueIdempotency.get(input.idempotencyKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          throw new ConflictException('Idempotency-Key reused with different quote parameters');
        }
        return { ...cached.value };
      }
    }

    const now = input.now ?? new Date();
    const rate = await this.rateSource.getRate(baseCurrency, quoteCurrency);
    this.validateRateSample(rate, now);

    const num = this.parsePositiveBoundedBigInt(rate.rateNumerator, 'rateNumerator', this.config.maxRateValue);
    const den = this.parsePositiveBoundedBigInt(rate.rateDenominator, 'rateDenominator', this.config.maxRateValue);
    const refNum = this.parsePositiveBoundedBigInt(
      rate.referenceRateNumerator,
      'referenceRateNumerator',
      this.config.maxRateValue,
    );
    const refDen = this.parsePositiveBoundedBigInt(
      rate.referenceRateDenominator,
      'referenceRateDenominator',
      this.config.maxRateValue,
    );

    this.assertSlippageWithinLimit(num, den, refNum, refDen);

    const product = amountBig * num;
    const converted = product / den; // Floor division: cannot create money
    const dust = product % den;

    if (converted <= 0n) {
      throw new ApiProblemException(ErrorCode.VALIDATION_FAILED, {
        detail: 'Converted amount rounds to zero minor units',
      });
    }
    if (converted > this.config.maxAmountMinorUnits) {
      throw new ApiProblemException(ErrorCode.VALIDATION_FAILED, {
        detail: 'Converted amount exceeds maximum supported minor units',
      });
    }

    const quote: ConversionQuote = {
      id: randomUUID(),
      baseCurrency,
      quoteCurrency,
      rateNumerator: num.toString(),
      rateDenominator: den.toString(),
      scale: rate.scale,
      source: rate.source,
      observedAt: rate.observedAt.toISOString(),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.ttlMs).toISOString(),
      amount: amountBig.toString(),
      convertedAmount: converted.toString(),
      dust: dust.toString(),
      roundingRule: 'floor',
      account,
      purpose: input.purpose,
      status: 'open',
    };

    this.quotes.set(quote.id, quote);
    if (input.idempotencyKey) {
      this.issueIdempotency.set(input.idempotencyKey, { fingerprint, value: { ...quote } });
    }
    return { ...quote };
  }

  /**
   * Atomically consume an open, unexpired quote bound to `account` and `purpose`.
   * If `onBeforeCommit` throws, the quote state is rolled back cleanly.
   */
  async consumeQuote(input: ConsumeQuoteInput): Promise<ConversionExecutionResult> {
    const account = this.normalizeNonEmpty(input.account, 'account');
    const fingerprint = this.fingerprint({
      op: 'consume',
      quoteId: input.quoteId,
      account,
      purpose: input.purpose,
    });

    if (input.idempotencyKey) {
      const cached = this.consumeIdempotency.get(input.idempotencyKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          throw new ConflictException('Idempotency-Key reused with different consume parameters');
        }
        return {
          ...cached.value,
          quote: { ...cached.value.quote },
          idempotentReplay: true,
        };
      }
    }

    if (this.inFlightQuotes.has(input.quoteId)) {
      throw new ApiProblemException(ErrorCode.QUOTE_ALREADY_USED, {
        status: HttpStatus.CONFLICT,
        detail: 'Quote is already being consumed by another concurrent request',
      });
    }

    this.inFlightQuotes.add(input.quoteId);
    try {
      const quote = this.quotes.get(input.quoteId);
      if (!quote) {
        throw new ApiProblemException(ErrorCode.NOT_FOUND, {
          status: HttpStatus.NOT_FOUND,
          detail: `Conversion quote ${input.quoteId} not found`,
        });
      }

      const now = input.now ?? new Date();
      if (quote.status === 'used') {
        throw new ApiProblemException(ErrorCode.QUOTE_ALREADY_USED, {
          status: HttpStatus.CONFLICT,
        });
      }

      if (quote.status === 'expired' || now.getTime() > new Date(quote.expiresAt).getTime()) {
        quote.status = 'expired';
        throw new ApiProblemException(ErrorCode.QUOTE_EXPIRED, {
          status: HttpStatus.GONE,
        });
      }

      if (quote.account !== account || quote.purpose !== input.purpose) {
        throw new ApiProblemException(ErrorCode.QUOTE_BINDING_MISMATCH, {
          status: HttpStatus.FORBIDDEN,
        });
      }

      const prevStatus = quote.status;
      quote.status = 'used';
      quote.consumedAt = now.toISOString();
      quote.consumedBy = account;

      if (input.onBeforeCommit) {
        try {
          await input.onBeforeCommit({ ...quote });
        } catch (err) {
          // Rollback halfway failure so quote is not left in a phantom used state
          const rollbackNow = new Date();
          quote.status =
            rollbackNow.getTime() > new Date(quote.expiresAt).getTime() ? 'expired' : prevStatus;
          delete quote.consumedAt;
          delete quote.consumedBy;
          throw err;
        }
      }

      const result: ConversionExecutionResult = {
        quote: { ...quote },
        convertedAmount: quote.convertedAmount,
        dust: quote.dust,
        idempotentReplay: false,
      };

      if (input.idempotencyKey) {
        this.consumeIdempotency.set(input.idempotencyKey, {
          fingerprint,
          value: { ...result, quote: { ...quote } },
        });
      }

      return result;
    } finally {
      this.inFlightQuotes.delete(input.quoteId);
    }
  }

  getQuote(quoteId: string): ConversionQuote {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      throw new ApiProblemException(ErrorCode.NOT_FOUND, {
        status: HttpStatus.NOT_FOUND,
        detail: `Conversion quote ${quoteId} not found`,
      });
    }
    return { ...quote };
  }

  private validateRateSample(rate: RateSample, now: Date): void {
    const observedMs = rate.observedAt.getTime();
    if (!Number.isFinite(observedMs)) {
      throw new ApiProblemException(ErrorCode.STALE_RATE_SOURCE, {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'Rate source observation timestamp is invalid',
      });
    }
    const ageMs = now.getTime() - observedMs;
    if (ageMs < 0 || ageMs > this.config.maxRateAgeMs) {
      throw new ApiProblemException(ErrorCode.STALE_RATE_SOURCE, {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        context: { ageMs, maxRateAgeMs: this.config.maxRateAgeMs, source: rate.source },
      });
    }
  }

  private assertSlippageWithinLimit(
    num: bigint,
    den: bigint,
    refNum: bigint,
    refDen: bigint,
  ): void {
    // Compare |num/den - refNum/refDen| / (refNum/refDen) <= maxSlippageBps / 10_000
    // Cross-multiplied in exact BigInt: |num * refDen - refNum * den| * 10_000 <= maxSlippageBps * refNum * den
    const lhs = num * refDen;
    const rhs = refNum * den;
    const diff = lhs >= rhs ? lhs - rhs : rhs - lhs;
    const slippageNumerator = diff * 10_000n;
    const maxAllowed = BigInt(this.config.maxSlippageBps) * rhs;
    if (slippageNumerator > maxAllowed) {
      throw new ApiProblemException(ErrorCode.QUOTE_SLIPPAGE_EXCEEDED, {
        status: HttpStatus.BAD_REQUEST,
        context: { maxSlippageBps: this.config.maxSlippageBps },
      });
    }
  }

  private parsePositiveBoundedBigInt(raw: string, field: string, max: bigint): bigint {
    if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
      throw new ApiProblemException(ErrorCode.VALIDATION_FAILED, {
        detail: `${field} must be a positive integer string in minor units`,
      });
    }
    const value = BigInt(raw.trim());
    if (value <= 0n) {
      throw new ApiProblemException(ErrorCode.VALIDATION_FAILED, {
        detail: `${field} must be greater than zero`,
      });
    }
    if (value > max) {
      throw new ApiProblemException(ErrorCode.VALIDATION_FAILED, {
        detail: `${field} exceeds maximum allowed bound`,
      });
    }
    return value;
  }

  private normalizeCurrency(value: string, field: string): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9]{2,12}$/.test(value.trim())) {
      throw new ApiProblemException(ErrorCode.VALIDATION_FAILED, {
        detail: `${field} must be a valid currency/asset code`,
      });
    }
    return value.trim().toUpperCase();
  }

  private normalizeNonEmpty(value: string, field: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ApiProblemException(ErrorCode.VALIDATION_FAILED, {
        detail: `${field} is required`,
      });
    }
    return value.trim();
  }

  private fingerprint(payload: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }
}
