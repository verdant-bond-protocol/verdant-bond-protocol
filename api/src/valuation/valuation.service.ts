import { Inject, Injectable, Logger } from '@nestjs/common';
import { CreditTypeEnum } from '../bonds/interfaces/bond.interface';
import { RedisService } from '../common/services/redis.service';
import { aggregateValuation } from './valuation.aggregator';
import { SOURCE_TIMEOUT_MS, VALUATION_CONFIG, ValuationConfig } from './valuation.config';
import {
  CreditPriceSource,
  CreditValuation,
  LastKnownPrice,
  SourceResult,
  ValuationReport,
  ValuationStatus,
} from './valuation.interface';

export const CREDIT_PRICE_SOURCES = Symbol('CREDIT_PRICE_SOURCES');

/** Last known prices outlive any realistic outage; a year-old price still reports as stale. */
const LAST_KNOWN_TTL_SECONDS = 365 * 86_400;

const lastKnownKey = (creditType: CreditTypeEnum) => `valuation:last:${creditType}`;

/**
 * Aggregates credit valuations from every configured price source (#204).
 *
 * Credit types are valued independently and concurrently, and every source call
 * is isolated (`Promise.allSettled` semantics + per-call timeout), so an outage
 * of one feed or one credit type never breaks the others. Each priced result
 * is persisted as the last known price, which is what a later outage degrades
 * to — labelled stale with its age rather than failing.
 *
 * Time O(T · S log S) for T credit types and S sources; network calls run in
 * parallel, so wall time is bounded by SOURCE_TIMEOUT_MS. Space O(T · S).
 */
@Injectable()
export class ValuationService {
  private readonly logger = new Logger(ValuationService.name);

  constructor(
    @Inject(CREDIT_PRICE_SOURCES) private readonly sources: CreditPriceSource[],
    @Inject(VALUATION_CONFIG) private readonly config: ValuationConfig,
    private readonly redis: RedisService,
  ) {}

  async getReport(
    creditTypes: CreditTypeEnum[] = Object.values(CreditTypeEnum),
    now: Date = new Date(),
  ): Promise<ValuationReport> {
    const valuations = await Promise.all(creditTypes.map((type) => this.value(type, now)));

    const summary: Record<ValuationStatus, CreditTypeEnum[]> = {
      current: [],
      estimated: [],
      stale: [],
      unavailable: [],
    };
    for (const valuation of valuations) summary[valuation.status].push(valuation.creditType);

    return { generatedAt: now.toISOString(), currency: this.config.currency, valuations, summary };
  }

  private async value(creditType: CreditTypeEnum, now: Date): Promise<CreditValuation> {
    const sources = this.sources.filter((source) => source.supports(creditType));
    const [results, lastKnown] = await Promise.all([
      Promise.all(sources.map((source) => this.query(source, creditType))),
      this.readLastKnown(creditType),
    ]);

    const valuation = aggregateValuation(
      creditType,
      this.config.currency,
      results,
      this.config.policies[creditType],
      now,
      lastKnown,
    );

    if ((valuation.status === 'current' || valuation.status === 'estimated') && valuation.price !== null) {
      await this.writeLastKnown(creditType, {
        price: valuation.price,
        currency: valuation.currency,
        observedAt: valuation.asOf as string,
        status: valuation.status,
      });
    }
    return valuation;
  }

  /** Never rejects: a failing source becomes an `error` result for the aggregator to report. */
  private async query(source: CreditPriceSource, creditType: CreditTypeEnum): Promise<SourceResult> {
    try {
      const quote = await source.fetchQuote(creditType, AbortSignal.timeout(SOURCE_TIMEOUT_MS));
      return { sourceId: source.id, ok: true, quote };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Price source ${source.id} failed for ${creditType}: ${message}`);
      return { sourceId: source.id, ok: false, error: message };
    }
  }

  private async readLastKnown(creditType: CreditTypeEnum): Promise<LastKnownPrice | null> {
    const raw = await this.redis.get(lastKnownKey(creditType));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LastKnownPrice;
    } catch {
      return null;
    }
  }

  private async writeLastKnown(creditType: CreditTypeEnum, price: LastKnownPrice): Promise<void> {
    await this.redis.setEx(lastKnownKey(creditType), LAST_KNOWN_TTL_SECONDS, JSON.stringify(price));
  }
}
