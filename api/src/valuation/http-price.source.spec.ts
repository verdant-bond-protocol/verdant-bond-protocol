import { CreditTypeEnum } from '../bonds/interfaces/bond.interface';
import { HttpPriceSource } from './http-price.source';

const feed = { id: 'feed-a', url: 'https://feed.example/price', creditTypes: [CreditTypeEnum.Carbon] };

describe('HttpPriceSource (#204)', () => {
  const fetchMock = jest.fn();
  const realFetch = global.fetch;
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  const respond = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue({ ok: status < 400, status, json: async () => body });

  it('requests the credit type and parses a conforming quote', async () => {
    respond(200, { price: '12.50', currency: 'usd', observedAt: '2026-09-25T10:00:00Z' });
    const source = new HttpPriceSource(feed);

    const quote = await source.fetchQuote(CreditTypeEnum.Carbon, new AbortController().signal);

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://feed.example/price?creditType=Carbon');
    expect(quote).toEqual({ price: 12.5, currency: 'USD', observedAt: new Date('2026-09-25T10:00:00Z') });
  });

  it('only supports its configured credit types', () => {
    const source = new HttpPriceSource(feed);
    expect(source.supports(CreditTypeEnum.Carbon)).toBe(true);
    expect(source.supports(CreditTypeEnum.Biodiversity)).toBe(false);
  });

  it('rejects an HTTP error and a malformed body instead of returning a price', async () => {
    const source = new HttpPriceSource(feed);
    const signal = new AbortController().signal;

    respond(503, {});
    await expect(source.fetchQuote(CreditTypeEnum.Carbon, signal)).rejects.toThrow('HTTP 503');

    respond(200, { price: 'twelve', currency: 'USD', observedAt: 'yesterday' });
    await expect(source.fetchQuote(CreditTypeEnum.Carbon, signal)).rejects.toThrow();
  });
});
