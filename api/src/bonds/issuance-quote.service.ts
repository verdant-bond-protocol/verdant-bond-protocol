import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * Bond issuance quotes with expiry and stale-price rejection (#435).
 *
 * A quote locks a price for a short window. It can only be accepted by the
 * investor it was issued to, before it expires, and only while the current
 * price is fresh and within `maxPriceDeviationBps` of the quoted price.
 * See docs/issuance-quotes.md.
 */

export interface PriceObservation {
  /** Price per bond unit, in quote-asset minor units. */
  priceMinor: string;
  /** Epoch milliseconds when the price was observed at its source. */
  observedAt: number;
  source: string;
}

export type IssuanceQuoteStatus = 'open' | 'accepted' | 'expired' | 'rejected';

export interface IssuanceQuote {
  quoteId: string;
  bondId: string;
  investor: string;
  amount: string;
  priceMinor: string;
  totalMinor: string;
  priceSource: string;
  priceObservedAt: number;
  issuedAt: number;
  expiresAt: number;
  status: IssuanceQuoteStatus;
  acceptedAt?: number;
  rejectionCode?: string;
}

export interface IssuanceQuoteConfig {
  quoteTtlMs: number;
  maxPriceAgeMs: number;
  /** Allowed clock skew for price timestamps that are slightly in the future. */
  maxFutureSkewMs: number;
  maxPriceDeviationBps: number;
}

export const DEFAULT_ISSUANCE_QUOTE_CONFIG: IssuanceQuoteConfig = {
  quoteTtlMs: 60_000,
  maxPriceAgeMs: 30_000,
  maxFutureSkewMs: 5_000,
  maxPriceDeviationBps: 50,
};

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

@Injectable()
export class IssuanceQuoteService {
  private readonly quotes = new Map<string, IssuanceQuote>();
  private config: IssuanceQuoteConfig = { ...DEFAULT_ISSUANCE_QUOTE_CONFIG };

  /** Overridable clock, so expiry is testable without timers. */
  now: () => number = () => Date.now();

  configure(config: Partial<IssuanceQuoteConfig>): IssuanceQuoteConfig {
    const next = { ...this.config, ...config };
    for (const [key, value] of Object.entries(next)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new BadRequestException({
          code: 'INVALID_QUOTE_CONFIG',
          message: `${key} must be a non-negative integer`,
        });
      }
    }
    if (next.quoteTtlMs === 0) {
      throw new BadRequestException({
        code: 'INVALID_QUOTE_CONFIG',
        message: 'quoteTtlMs must be greater than zero',
      });
    }
    this.config = next;
    return { ...next };
  }

  createQuote(
    request: { bondId: string; investor: string; amount: string },
    price: PriceObservation,
  ): IssuanceQuote {
    if (!request.bondId || !request.investor) {
      throw new BadRequestException({
        code: 'INVALID_QUOTE_REQUEST',
        message: 'bondId and investor are required',
      });
    }
    if (!POSITIVE_INTEGER.test(request.amount)) {
      throw new BadRequestException({
        code: 'INVALID_QUOTE_REQUEST',
        message: 'amount must be a positive integer string',
      });
    }
    this.assertFreshPrice(price);

    const issuedAt = this.now();
    const quote: IssuanceQuote = {
      quoteId: randomUUID(),
      bondId: request.bondId,
      investor: request.investor,
      amount: request.amount,
      priceMinor: price.priceMinor,
      totalMinor: (BigInt(request.amount) * BigInt(price.priceMinor)).toString(),
      priceSource: price.source,
      priceObservedAt: price.observedAt,
      issuedAt,
      expiresAt: issuedAt + this.config.quoteTtlMs,
      status: 'open',
    };
    this.quotes.set(quote.quoteId, quote);
    return { ...quote };
  }

  getQuote(quoteId: string): IssuanceQuote {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      throw new NotFoundException({ code: 'QUOTE_NOT_FOUND', message: `Quote ${quoteId} not found` });
    }
    return { ...quote };
  }

  /**
   * Accepts a quote against the current price. Accepting an already accepted
   * quote returns it unchanged, so client retries are safe.
   */
  acceptQuote(quoteId: string, investor: string, currentPrice: PriceObservation): IssuanceQuote {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      throw new NotFoundException({ code: 'QUOTE_NOT_FOUND', message: `Quote ${quoteId} not found` });
    }
    if (quote.investor !== investor) {
      throw new ForbiddenException({
        code: 'QUOTE_NOT_OWNED',
        message: 'Quote was issued to a different investor',
      });
    }
    if (quote.status === 'accepted') {
      return { ...quote };
    }
    if (quote.status === 'rejected') {
      throw new ConflictException({
        code: quote.rejectionCode ?? 'QUOTE_REJECTED',
        message: 'Quote was rejected; request a new quote',
      });
    }
    if (quote.status === 'expired' || this.now() >= quote.expiresAt) {
      quote.status = 'expired';
      throw new GoneException({ code: 'QUOTE_EXPIRED', message: 'Quote has expired; request a new quote' });
    }

    // A stale current price leaves the quote open: the client can retry
    // once a fresh price is available, before the quote expires.
    this.assertFreshPrice(currentPrice);

    const quoted = BigInt(quote.priceMinor);
    const current = BigInt(currentPrice.priceMinor);
    const diff = current > quoted ? current - quoted : quoted - current;
    if (diff * 10_000n > quoted * BigInt(this.config.maxPriceDeviationBps)) {
      quote.status = 'rejected';
      quote.rejectionCode = 'PRICE_MOVED';
      throw new ConflictException({
        code: 'PRICE_MOVED',
        message: 'Price moved beyond the allowed deviation; request a new quote',
      });
    }

    quote.status = 'accepted';
    quote.acceptedAt = this.now();
    return { ...quote };
  }

  /** Marks open quotes past their expiry as expired. Returns how many changed. */
  expireDue(): number {
    const now = this.now();
    let expired = 0;
    for (const quote of this.quotes.values()) {
      if (quote.status === 'open' && now >= quote.expiresAt) {
        quote.status = 'expired';
        expired += 1;
      }
    }
    return expired;
  }

  private assertFreshPrice(price: PriceObservation): void {
    if (!POSITIVE_INTEGER.test(price.priceMinor)) {
      throw new BadRequestException({
        code: 'INVALID_PRICE',
        message: 'priceMinor must be a positive integer string',
      });
    }
    const now = this.now();
    if (!Number.isFinite(price.observedAt) || price.observedAt > now + this.config.maxFutureSkewMs) {
      throw new BadRequestException({
        code: 'INVALID_PRICE',
        message: 'Price timestamp is in the future',
      });
    }
    if (now - price.observedAt > this.config.maxPriceAgeMs) {
      throw new BadRequestException({
        code: 'STALE_PRICE',
        message: `Price is older than ${this.config.maxPriceAgeMs}ms`,
      });
    }
  }
}
