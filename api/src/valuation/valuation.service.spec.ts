import { CreditTypeEnum } from '../bonds/interfaces/bond.interface';
import { RedisService } from '../common/services/redis.service';
import { DEFAULT_POLICIES, ValuationConfig } from './valuation.config';
import { CreditPriceSource, PriceQuote } from './valuation.interface';
import { ValuationService } from './valuation.service';

const NOW = new Date('2026-09-25T12:00:00Z');

function source(
  id: string,
  types: CreditTypeEnum[],
  respond: (type: CreditTypeEnum) => Promise<PriceQuote>,
): CreditPriceSource {
  return { id, supports: (t) => types.includes(t), fetchQuote: (t) => respond(t) };
}

const priced = (price: number): Promise<PriceQuote> =>
  Promise.resolve({ price, currency: 'USD', observedAt: new Date(NOW.getTime() - 60_000) });

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    setEx: jest.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    }),
  };
}

const config: ValuationConfig = { currency: 'USD', feeds: [], policies: DEFAULT_POLICIES };

describe('ValuationService (#204)', () => {
  it('keeps valuing other credit types when every source for one type is down', async () => {
    const redis = fakeRedis();
    const service = new ValuationService(
      [
        source('a', [CreditTypeEnum.Carbon, CreditTypeEnum.Biodiversity], (t) =>
          t === CreditTypeEnum.Biodiversity ? Promise.reject(new Error('HTTP 503')) : priced(10),
        ),
        source('b', [CreditTypeEnum.Carbon, CreditTypeEnum.Biodiversity], (t) =>
          t === CreditTypeEnum.Biodiversity ? Promise.reject(new Error('timeout')) : priced(10.5),
        ),
      ],
      config,
      redis as unknown as RedisService,
    );

    const report = await service.getReport([CreditTypeEnum.Carbon, CreditTypeEnum.Biodiversity], NOW);

    const [carbon, biodiversity] = report.valuations;
    expect(carbon).toMatchObject({ status: 'current', price: 10.25 });
    expect(biodiversity).toMatchObject({ status: 'unavailable', price: null });
    expect(biodiversity.sources.map((s) => s.status)).toEqual(['error', 'error']);
    expect(report.summary).toEqual({
      current: [CreditTypeEnum.Carbon],
      estimated: [],
      stale: [],
      unavailable: [CreditTypeEnum.Biodiversity],
    });
  });

  it('serves the persisted last known price as stale once the feed goes down', async () => {
    const redis = fakeRedis();
    let up = true;
    const feeds = ['a', 'b'].map((id, i) =>
      source(id, [CreditTypeEnum.Carbon], () => (up ? priced(10 + i) : Promise.reject(new Error('down')))),
    );
    const service = new ValuationService(feeds, config, redis as unknown as RedisService);

    await service.getReport([CreditTypeEnum.Carbon], NOW);
    expect(redis.setEx).toHaveBeenCalledWith('valuation:last:Carbon', 365 * 86_400, expect.any(String));

    up = false;
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    const { valuations } = await service.getReport([CreditTypeEnum.Carbon], later);

    expect(valuations[0]).toMatchObject({ status: 'stale', price: 10.5, label: 'Stale — last known price, 2 days old' });
  });

  it('does not overwrite the last known price with a stale or unavailable result', async () => {
    const redis = fakeRedis();
    const service = new ValuationService(
      [source('a', [CreditTypeEnum.Carbon], () => Promise.reject(new Error('down')))],
      config,
      redis as unknown as RedisService,
    );

    await service.getReport([CreditTypeEnum.Carbon], NOW);
    expect(redis.setEx).not.toHaveBeenCalled();
  });

  it('passes each source an abort signal so a hung feed is cut off', async () => {
    const fetchQuote = jest.fn((_type: CreditTypeEnum, signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return priced(10);
    });
    const service = new ValuationService(
      [{ id: 'a', supports: () => true, fetchQuote }],
      config,
      fakeRedis() as unknown as RedisService,
    );

    await service.getReport([CreditTypeEnum.Carbon], NOW);
    expect(fetchQuote).toHaveBeenCalledTimes(1);
  });
});
