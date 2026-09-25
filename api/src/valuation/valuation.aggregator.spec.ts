import { CreditTypeEnum } from '../bonds/interfaces/bond.interface';
import { aggregateValuation, median } from './valuation.aggregator';
import { SourceResult, ValuationPolicy } from './valuation.interface';

const NOW = new Date('2026-09-25T12:00:00Z');
const POLICY: ValuationPolicy = { maxAgeSeconds: 86_400, tolerance: 0.25 };
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const quote = (sourceId: string, price: number, ageHours = 1, currency = 'USD'): SourceResult => ({
  sourceId,
  ok: true,
  quote: { price, currency, observedAt: hoursAgo(ageHours) },
});
const failure = (sourceId: string): SourceResult => ({ sourceId, ok: false, error: 'HTTP 503' });

const value = (results: SourceResult[], lastKnown = null as Parameters<typeof aggregateValuation>[5]) =>
  aggregateValuation(CreditTypeEnum.Carbon, 'USD', results, POLICY, NOW, lastKnown);

describe('aggregateValuation (#204)', () => {
  it('is current when two or more fresh sources agree, priced at their median', () => {
    const v = value([quote('a', 10), quote('b', 11), quote('c', 12)]);
    expect(v.status).toBe('current');
    expect(v.price).toBe(11);
    expect(v.label).toBe('Current — median of 3 agreeing sources');
    expect(v.sources.every((s) => s.status === 'accepted')).toBe(true);
  });

  it('rejects a single erroneous source instead of letting it move the price', () => {
    const v = value([quote('a', 10), quote('b', 10.4), quote('bad', 100)]);
    expect(v.status).toBe('current');
    expect(v.price).toBe(10.2);
    const bad = v.sources.find((s) => s.sourceId === 'bad')!;
    expect(bad.status).toBe('outlier');
    expect(bad.reason).toMatch(/beyond the 25% tolerance/);
  });

  it('marks a lone fresh source as estimated, not current', () => {
    const v = value([quote('a', 10), failure('b')]);
    expect(v.status).toBe('estimated');
    expect(v.price).toBe(10);
    expect(v.label).toBe('Estimated — single source, not cross-checked');
    expect(v.sources.find((s) => s.sourceId === 'b')!.status).toBe('error');
  });

  it('marks disagreeing sources as estimated when no two agree', () => {
    const v = value([quote('a', 10), quote('b', 20)]);
    expect(v.status).toBe('estimated');
    expect(v.price).toBe(15);
    expect(v.label).toBe('Estimated — 2 sources disagree beyond 25%');
  });

  it('degrades to the last known price with its age when every source is down', () => {
    const observedAt = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    const v = value([failure('a'), failure('b')], { price: 9.5, currency: 'USD', observedAt, status: 'current' });
    expect(v.status).toBe('stale');
    expect(v.price).toBe(9.5);
    expect(v.asOf).toBe(observedAt);
    expect(v.ageSeconds).toBe(3 * 86_400);
    expect(v.label).toBe('Stale — last known price, 3 days old');
  });

  it('prefers a stale source quote newer than the last known price', () => {
    const v = value([quote('a', 12, 30)], {
      price: 9,
      currency: 'USD',
      observedAt: hoursAgo(72).toISOString(),
      status: 'current',
    });
    expect(v.status).toBe('stale');
    expect(v.price).toBe(12);
    expect(v.label).toBe('Stale — last known price, 1 day old');
    expect(v.sources[0].status).toBe('stale');
  });

  it('is unavailable, never zero, when nothing has ever been observed', () => {
    const v = value([failure('a')]);
    expect(v).toMatchObject({ status: 'unavailable', price: null, asOf: null, ageSeconds: null });
  });

  it('rejects invalid quotes: wrong currency, non-positive price, future timestamp', () => {
    const v = value([quote('eur', 10, 1, 'EUR'), quote('zero', 0), quote('future', 10, -2)]);
    expect(v.status).toBe('unavailable');
    expect(v.sources.map((s) => s.status)).toEqual(['invalid', 'invalid', 'invalid']);
  });
});

describe('median', () => {
  it('handles odd and even counts without mutating the input', () => {
    const input = [3, 1, 2, 4];
    expect(median(input)).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(input).toEqual([3, 1, 2, 4]);
  });
});
