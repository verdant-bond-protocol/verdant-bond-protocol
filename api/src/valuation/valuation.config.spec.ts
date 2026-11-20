import { CreditTypeEnum } from '../bonds/interfaces/bond.interface';
import { DEFAULT_POLICIES, loadValuationConfig } from './valuation.config';

describe('loadValuationConfig (#204)', () => {
  it('defaults to no feeds, USD and the default policies', () => {
    expect(loadValuationConfig({})).toEqual({ currency: 'USD', feeds: [], policies: DEFAULT_POLICIES });
  });

  it('parses feeds and merges partial policy overrides', () => {
    const config = loadValuationConfig({
      CREDIT_PRICE_FEEDS: JSON.stringify([
        { id: 'a', url: 'https://feed.example/price', creditTypes: ['Carbon', 'BlueCarbon'] },
      ]),
      CREDIT_VALUATION_POLICY: JSON.stringify({ Biodiversity: { maxAgeSeconds: 100 } }),
      VALUATION_CURRENCY: 'eur',
    });

    expect(config.currency).toBe('EUR');
    expect(config.feeds[0].creditTypes).toEqual([CreditTypeEnum.Carbon, CreditTypeEnum.BlueCarbon]);
    expect(config.policies.Biodiversity).toEqual({ maxAgeSeconds: 100, tolerance: DEFAULT_POLICIES.Biodiversity.tolerance });
  });

  it.each([
    ['an unknown credit type', { CREDIT_PRICE_FEEDS: '[{"id":"a","url":"https://x.example","creditTypes":["Gold"]}]' }],
    ['a relative url', { CREDIT_PRICE_FEEDS: '[{"id":"a","url":"/price","creditTypes":["Carbon"]}]' }],
    ['duplicate feed ids', { CREDIT_PRICE_FEEDS: '[{"id":"a","url":"https://x.example","creditTypes":["Carbon"]},{"id":"a","url":"https://y.example","creditTypes":["Carbon"]}]' }],
    ['a non-ISO currency', { VALUATION_CURRENCY: 'DOLLARS' }],
    ['a negative tolerance', { CREDIT_VALUATION_POLICY: '{"Carbon":{"tolerance":-1}}' }],
  ])('fails fast on %s', (_label, env) => {
    expect(() => loadValuationConfig(env)).toThrow();
  });
});
