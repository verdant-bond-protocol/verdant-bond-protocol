import { CreditTypeEnum } from '../bonds/interfaces/bond.interface';
import {
  CreditValuation,
  LastKnownPrice,
  SourceAssessment,
  SourceResult,
  ValuationPolicy,
} from './valuation.interface';

/**
 * Pure aggregation of one credit type's source quotes into a valuation (#204).
 *
 * Outlier handling follows the same principle as the oracle's cross-source
 * anomaly detection (`oracle/anomaly.detector.ts`): compare each fresh quote
 * against the median of the fresh quotes and reject any whose relative
 * deviation exceeds the credit type's tolerance. The median is robust to a
 * single wrong source, so one bad feed cannot move an accepted price.
 *
 *   ≥2 fresh quotes, ≥2 agree  → `current`, median of the agreeing quotes
 *   fresh quotes, <2 agree     → `estimated`, median of all fresh quotes
 *   no fresh quotes            → `stale`, newest of stale quotes / last known
 *   nothing at all             → `unavailable`
 *
 * Time O(S log S) for S sources (one sort); space O(S).
 */
export function aggregateValuation(
  creditType: CreditTypeEnum,
  currency: string,
  results: SourceResult[],
  policy: ValuationPolicy,
  now: Date,
  lastKnown: LastKnownPrice | null,
): CreditValuation {
  const assessments: SourceAssessment[] = [];
  const fresh: SourceAssessment[] = [];
  const stale: SourceAssessment[] = [];

  for (const result of results) {
    const assessment = assessSource(result, currency, policy, now);
    assessments.push(assessment);
    if (assessment.status === 'accepted') fresh.push(assessment);
    else if (assessment.status === 'stale') stale.push(assessment);
  }

  if (fresh.length > 0) {
    const reference = median(fresh.map((s) => s.price as number));
    for (const source of fresh) {
      source.deviation = relativeDeviation(source.price as number, reference);
      if (fresh.length > 1 && source.deviation > policy.tolerance) {
        source.status = 'outlier';
        source.reason =
          `Deviates ${percent(source.deviation)} from the median of fresh quotes, ` +
          `beyond the ${percent(policy.tolerance)} tolerance.`;
      }
    }

    const agreeing = fresh.filter((s) => s.status === 'accepted');
    const consensus = agreeing.length >= 2;
    const price = consensus ? median(agreeing.map((s) => s.price as number)) : reference;
    const observedAt = newest((consensus ? agreeing : fresh).map((s) => s.observedAt as string));

    return build(creditType, currency, price, consensus ? 'current' : 'estimated', observedAt, now, assessments,
      consensus
        ? `Current — median of ${agreeing.length} agreeing sources`
        : fresh.length === 1
          ? 'Estimated — single source, not cross-checked'
          : `Estimated — ${fresh.length} sources disagree beyond ${percent(policy.tolerance)}`);
  }

  const fallback = latest(stale, lastKnown, currency);
  if (fallback) {
    const days = Math.floor(ageSeconds(fallback.observedAt, now) / 86_400);
    return build(creditType, currency, fallback.price, 'stale', fallback.observedAt, now, assessments,
      `Stale — last known price, ${days} ${days === 1 ? 'day' : 'days'} old`);
  }

  return build(creditType, currency, null, 'unavailable', null, now, assessments, 'Unavailable — no price observed');
}

function assessSource(
  result: SourceResult,
  currency: string,
  policy: ValuationPolicy,
  now: Date,
): SourceAssessment {
  const base = { sourceId: result.sourceId, deviation: null };
  if (!result.ok) {
    return { ...base, status: 'error', price: null, observedAt: null, ageSeconds: null, reason: result.error };
  }

  const { price, observedAt } = result.quote;
  const observed = observedAt.toISOString();
  const age = ageSeconds(observed, now);

  if (!Number.isFinite(price) || price <= 0) {
    return { ...base, status: 'invalid', price: null, observedAt: observed, ageSeconds: age, reason: 'Price is not a positive number.' };
  }
  if (result.quote.currency !== currency) {
    return { ...base, status: 'invalid', price, observedAt: observed, ageSeconds: age, reason: `Quoted in ${result.quote.currency}, expected ${currency}.` };
  }
  if (age < 0) {
    return { ...base, status: 'invalid', price, observedAt: observed, ageSeconds: age, reason: 'Observation time is in the future.' };
  }
  if (age > policy.maxAgeSeconds) {
    return { ...base, status: 'stale', price, observedAt: observed, ageSeconds: age, reason: `Older than ${policy.maxAgeSeconds} s.` };
  }
  return { ...base, status: 'accepted', price, observedAt: observed, ageSeconds: age, reason: null };
}

/** Newest stale price among the sources and the persisted last known price. */
function latest(
  stale: SourceAssessment[],
  lastKnown: LastKnownPrice | null,
  currency: string,
): { price: number; observedAt: string } | null {
  let best: { price: number; observedAt: string } | null =
    lastKnown && lastKnown.currency === currency
      ? { price: lastKnown.price, observedAt: lastKnown.observedAt }
      : null;
  for (const source of stale) {
    if (!best || Date.parse(source.observedAt as string) > Date.parse(best.observedAt)) {
      best = { price: source.price as number, observedAt: source.observedAt as string };
    }
  }
  return best;
}

function build(
  creditType: CreditTypeEnum,
  currency: string,
  price: number | null,
  status: CreditValuation['status'],
  asOf: string | null,
  now: Date,
  sources: SourceAssessment[],
  label: string,
): CreditValuation {
  return {
    creditType,
    currency,
    price,
    status,
    asOf,
    ageSeconds: asOf === null ? null : ageSeconds(asOf, now),
    label,
    sources,
  };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function relativeDeviation(value: number, reference: number): number {
  return Math.abs(value - reference) / reference;
}

function ageSeconds(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 1000);
}

function newest(isoTimes: string[]): string {
  return isoTimes.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
