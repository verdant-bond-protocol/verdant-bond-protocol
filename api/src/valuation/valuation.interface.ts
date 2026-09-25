import { CreditTypeEnum } from '../bonds/interfaces/bond.interface';

/**
 * Credit valuation types (#204).
 *
 * A valuation is the fiat-equivalent price of ONE whole credit of a given type,
 * aggregated across independent price sources. Every valuation carries explicit
 * staleness metadata so investor-facing reports never present an old or
 * single-source number as a current market price.
 */

/** One quote as returned by a single external price source. */
export interface PriceQuote {
  price: number;
  currency: string;
  observedAt: Date;
}

/** Port implemented by every external price feed adapter. */
export interface CreditPriceSource {
  readonly id: string;
  supports(creditType: CreditTypeEnum): boolean;
  fetchQuote(creditType: CreditTypeEnum, signal: AbortSignal): Promise<PriceQuote>;
}

/** Outcome of asking one source for one credit type. */
export type SourceResult =
  | { sourceId: string; ok: true; quote: PriceQuote }
  | { sourceId: string; ok: false; error: string };

/**
 * - `current`     — at least two fresh sources agree within tolerance.
 * - `estimated`   — a fresh price exists but could not be cross-checked
 *                   (single source, or sources disagree).
 * - `stale`       — no fresh price; the last known price is shown with its age.
 * - `unavailable` — no price has ever been observed for this credit type.
 */
export type ValuationStatus = 'current' | 'estimated' | 'stale' | 'unavailable';

export type SourceStatus = 'accepted' | 'outlier' | 'stale' | 'invalid' | 'error';

export interface SourceAssessment {
  sourceId: string;
  status: SourceStatus;
  price: number | null;
  observedAt: string | null;
  ageSeconds: number | null;
  /** Relative distance from the fresh-quote median; null when not compared. */
  deviation: number | null;
  reason: string | null;
}

export interface CreditValuation {
  creditType: CreditTypeEnum;
  currency: string;
  price: number | null;
  status: ValuationStatus;
  /** When the underlying price was observed (not when it was computed). */
  asOf: string | null;
  ageSeconds: number | null;
  /** Human-readable status for reports, e.g. "Stale — last known price, 3 days old". */
  label: string;
  sources: SourceAssessment[];
}

export interface ValuationReport {
  generatedAt: string;
  currency: string;
  valuations: CreditValuation[];
  /** Credit types grouped by status, so a report reader sees at a glance what is not current. */
  summary: Record<ValuationStatus, CreditTypeEnum[]>;
}

/** Freshness and agreement rules for one credit type. */
export interface ValuationPolicy {
  /** A quote older than this is stale and never counts as current. */
  maxAgeSeconds: number;
  /** Maximum relative deviation from the median for a quote to be accepted. */
  tolerance: number;
}

/** The last priced valuation, persisted so an outage degrades to "stale" rather than failing. */
export interface LastKnownPrice {
  price: number;
  currency: string;
  observedAt: string;
  status: Extract<ValuationStatus, 'current' | 'estimated'>;
}
