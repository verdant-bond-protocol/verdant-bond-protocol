import { z } from 'zod';
import { CreditTypeEnum } from '../bonds/interfaces/bond.interface';
import { FeedConfig } from './valuation.config';
import { CreditPriceSource, PriceQuote } from './valuation.interface';

/**
 * A configured HTTP price feed (#204).
 *
 * Contract: `GET <url>?creditType=<CreditType>` answers with
 * `{ "price": number | numeric string, "currency": "USD", "observedAt": ISO-8601 }`,
 * the price of one whole credit. Operators point CREDIT_PRICE_FEEDS at feeds
 * (or thin adapters in front of vendors) that honour this contract; any
 * response that does not is reported as a source error, never as a price.
 */
const quoteSchema = z.object({
  price: z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/).transform(Number)]),
  currency: z.string().length(3).transform((c) => c.toUpperCase()),
  observedAt: z.string().datetime({ offset: true }).transform((s) => new Date(s)),
});

export class HttpPriceSource implements CreditPriceSource {
  readonly id: string;
  private readonly types: ReadonlySet<CreditTypeEnum>;

  constructor(private readonly feed: FeedConfig) {
    this.id = feed.id;
    this.types = new Set(feed.creditTypes);
  }

  supports(creditType: CreditTypeEnum): boolean {
    return this.types.has(creditType);
  }

  async fetchQuote(creditType: CreditTypeEnum, signal: AbortSignal): Promise<PriceQuote> {
    const url = new URL(this.feed.url);
    url.searchParams.set('creditType', creditType);

    const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return quoteSchema.parse(await response.json());
  }
}
