import { z } from 'zod';
import { CreditTypeEnum } from '../bonds/interfaces/bond.interface';
import { ValuationPolicy } from './valuation.interface';

/**
 * Valuation configuration (#204), read once from the environment:
 *
 *   CREDIT_PRICE_FEEDS      JSON array of feeds, e.g.
 *                           [{"id":"feed-a","url":"https://…/price","creditTypes":["Carbon","BlueCarbon"]}]
 *   VALUATION_CURRENCY      ISO 4217 code every feed must quote in (default USD)
 *   CREDIT_VALUATION_POLICY optional JSON overriding DEFAULT_POLICIES per credit type, e.g.
 *                           {"Biodiversity":{"maxAgeSeconds":5184000}}
 *
 * Invalid configuration fails fast at startup instead of silently producing
 * empty valuations.
 */

const DAY = 86_400;

/**
 * Defaults reflect how often each market realistically reprices: carbon
 * credits trade most, biodiversity credits least. Tolerance mirrors the
 * oracle's cross-source tolerance range (15–35%, see anomaly.detector.ts).
 */
export const DEFAULT_POLICIES: Record<CreditTypeEnum, ValuationPolicy> = {
  [CreditTypeEnum.Carbon]: { maxAgeSeconds: 2 * DAY, tolerance: 0.25 },
  [CreditTypeEnum.BlueCarbon]: { maxAgeSeconds: 7 * DAY, tolerance: 0.25 },
  [CreditTypeEnum.Basket]: { maxAgeSeconds: 7 * DAY, tolerance: 0.25 },
  [CreditTypeEnum.Biodiversity]: { maxAgeSeconds: 30 * DAY, tolerance: 0.35 },
};

/** A single slow feed must not hold up the whole report. */
export const SOURCE_TIMEOUT_MS = 5_000;

const creditType = z.nativeEnum(CreditTypeEnum);

const feedsSchema = z.array(
  z.object({
    id: z.string().min(1),
    url: z.string().url(),
    creditTypes: z.array(creditType).min(1),
  }),
);

const policySchema = z.object({
  maxAgeSeconds: z.number().int().positive(),
  tolerance: z.number().positive(),
});

const policyOverridesSchema = z.record(creditType, policySchema.partial());

export type FeedConfig = z.infer<typeof feedsSchema>[number];

export interface ValuationConfig {
  currency: string;
  feeds: FeedConfig[];
  policies: Record<CreditTypeEnum, ValuationPolicy>;
}

export const VALUATION_CONFIG = Symbol('VALUATION_CONFIG');

export function loadValuationConfig(env: NodeJS.ProcessEnv = process.env): ValuationConfig {
  const feeds = feedsSchema.parse(JSON.parse(env.CREDIT_PRICE_FEEDS || '[]'));
  const ids = new Set(feeds.map((feed) => feed.id));
  if (ids.size !== feeds.length) {
    throw new Error('CREDIT_PRICE_FEEDS contains duplicate feed ids.');
  }

  const overrides = policyOverridesSchema.parse(JSON.parse(env.CREDIT_VALUATION_POLICY || '{}'));
  const policies = { ...DEFAULT_POLICIES };
  for (const [type, override] of Object.entries(overrides) as [CreditTypeEnum, Partial<ValuationPolicy>][]) {
    policies[type] = { ...policies[type], ...override };
  }

  const currency = (env.VALUATION_CURRENCY || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`VALUATION_CURRENCY must be an ISO 4217 code, got "${currency}".`);
  }

  return { currency, feeds, policies };
}
