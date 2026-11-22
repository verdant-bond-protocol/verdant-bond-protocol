export type ConversionPurpose =
  | 'bond_subscription'
  | 'coupon_settlement'
  | 'secondary_trade'
  | 'redemption';

export type QuoteStatus = 'open' | 'used' | 'expired';

export interface RateSample {
  baseCurrency: string;
  quoteCurrency: string;
  /** Integer numerator of the conversion rate (quote per base). */
  rateNumerator: string;
  /** Positive integer denominator of the conversion rate. */
  rateDenominator: string;
  /** Fixed-point decimal scale represented by the ratio (default 7 for Stellar stroops). */
  scale: number;
  /** Reference rate numerator for slippage / deviation checks. */
  referenceRateNumerator: string;
  /** Reference rate denominator for slippage / deviation checks. */
  referenceRateDenominator: string;
  source: string;
  observedAt: Date;
}

export interface CurrencyRateSource {
  readonly id: string;
  getRate(baseCurrency: string, quoteCurrency: string): Promise<RateSample>;
}

export const CURRENCY_RATE_SOURCE = Symbol('CURRENCY_RATE_SOURCE');
export const QUOTE_CONVERSION_CONFIG = Symbol('QUOTE_CONVERSION_CONFIG');

export interface QuoteConversionConfig {
  /** Quote time-to-live in milliseconds (default 30_000). */
  ttlMs: number;
  /** Maximum acceptable age of rate source observation in milliseconds (default 60_000). */
  maxRateAgeMs: number;
  /** Maximum allowed deviation from reference rate in basis points (default 100 = 1%). */
  maxSlippageBps: number;
  /** Maximum allowed input/output amount in minor units (default 10^18). */
  maxAmountMinorUnits: bigint;
  /** Maximum allowed rate numerator/denominator value (default 10^15). */
  maxRateValue: bigint;
}

export interface ConversionQuote {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rateNumerator: string;
  rateDenominator: string;
  scale: number;
  source: string;
  observedAt: string;
  issuedAt: string;
  expiresAt: string;
  /** Input amount in integer minor units. */
  amount: string;
  /** Output amount in integer minor units, floored so conversion cannot create value. */
  convertedAmount: string;
  /** Unconverted remainder in rateDenominator units: (amount * rateNumerator) % rateDenominator. */
  dust: string;
  /** Rounding rule applied to this quote. */
  roundingRule: 'floor';
  account: string;
  purpose: ConversionPurpose;
  status: QuoteStatus;
  consumedAt?: string;
  consumedBy?: string;
}

export interface IssueQuoteInput {
  baseCurrency: string;
  quoteCurrency: string;
  amount: string;
  account: string;
  purpose: ConversionPurpose;
  idempotencyKey?: string;
  now?: Date;
}

export interface ConsumeQuoteInput {
  quoteId: string;
  account: string;
  purpose: ConversionPurpose;
  idempotencyKey?: string;
  now?: Date;
  /** Optional hook executed before final commit; throwing rolls back consumption. */
  onBeforeCommit?: (quote: ConversionQuote) => Promise<void> | void;
}

export interface ConversionExecutionResult {
  quote: ConversionQuote;
  convertedAmount: string;
  dust: string;
  idempotentReplay: boolean;
}
