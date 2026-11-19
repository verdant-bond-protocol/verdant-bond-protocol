import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { IssuanceQuoteService, PriceObservation } from './issuance-quote.service';

const INVESTOR = 'GINVESTOR';
const OTHER = 'GOTHER';

describe('IssuanceQuoteService (#435)', () => {
  let service: IssuanceQuoteService;
  let clock: number;

  const price = (priceMinor: string, ageMs = 0): PriceObservation => ({
    priceMinor,
    observedAt: clock - ageMs,
    source: 'oracle',
  });

  const quote = () =>
    service.createQuote({ bondId: 'bond-1', investor: INVESTOR, amount: '10' }, price('1000000'));

  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (err) {
      return (err as { getResponse(): { code?: string } }).getResponse().code;
    }
    return undefined;
  };

  beforeEach(() => {
    clock = 1_700_000_000_000;
    service = new IssuanceQuoteService();
    service.now = () => clock;
  });

  describe('normal path', () => {
    it('locks price, total and expiry', () => {
      const q = quote();
      expect(q.status).toBe('open');
      expect(q.totalMinor).toBe('10000000');
      expect(q.expiresAt).toBe(clock + 60_000);
    });

    it('accepts within the window at an unchanged price', () => {
      const q = quote();
      clock += 10_000;
      const accepted = service.acceptQuote(q.quoteId, INVESTOR, price('1000000'));
      expect(accepted.status).toBe('accepted');
      expect(accepted.acceptedAt).toBe(clock);
    });

    it('accepts a price move inside the deviation band', () => {
      const q = quote();
      // 50 bps of 1_000_000 is 5_000.
      expect(service.acceptQuote(q.quoteId, INVESTOR, price('1005000')).status).toBe('accepted');
    });

    it('handles amounts beyond Number.MAX_SAFE_INTEGER exactly', () => {
      const q = service.createQuote(
        { bondId: 'bond-1', investor: INVESTOR, amount: '9007199254740993' },
        price('3'),
      );
      expect(q.totalMinor).toBe('27021597764222979');
    });
  });

  describe('failure paths', () => {
    it('rejects creating a quote from a stale price', () => {
      expect(() =>
        service.createQuote({ bondId: 'b', investor: INVESTOR, amount: '1' }, price('1', 30_001)),
      ).toThrow(BadRequestException);
      expect(
        codeOf(() => service.createQuote({ bondId: 'b', investor: INVESTOR, amount: '1' }, price('1', 30_001))),
      ).toBe('STALE_PRICE');
    });

    it('accepts a price exactly at the max age', () => {
      expect(
        service.createQuote({ bondId: 'b', investor: INVESTOR, amount: '1' }, price('1', 30_000)).status,
      ).toBe('open');
    });

    it('rejects prices from the future beyond skew', () => {
      expect(
        codeOf(() =>
          service.createQuote({ bondId: 'b', investor: INVESTOR, amount: '1' }, price('1', -5_001)),
        ),
      ).toBe('INVALID_PRICE');
    });

    it('rejects malformed amounts and prices', () => {
      for (const amount of ['0', '-1', '1.5', '', '01']) {
        expect(
          codeOf(() => service.createQuote({ bondId: 'b', investor: INVESTOR, amount }, price('1'))),
        ).toBe('INVALID_QUOTE_REQUEST');
      }
      expect(
        codeOf(() => service.createQuote({ bondId: 'b', investor: INVESTOR, amount: '1' }, price('0'))),
      ).toBe('INVALID_PRICE');
    });

    it('expires quotes at expiresAt', () => {
      const q = quote();
      clock = q.expiresAt;
      expect(() => service.acceptQuote(q.quoteId, INVESTOR, price('1000000'))).toThrow(GoneException);
      expect(service.getQuote(q.quoteId).status).toBe('expired');
    });

    it('rejects and closes the quote when the price moved too far', () => {
      const q = quote();
      expect(() => service.acceptQuote(q.quoteId, INVESTOR, price('1005001'))).toThrow(ConflictException);
      expect(service.getQuote(q.quoteId).status).toBe('rejected');
      expect(codeOf(() => service.acceptQuote(q.quoteId, INVESTOR, price('1000000')))).toBe('PRICE_MOVED');
    });

    it('returns not found for unknown quotes', () => {
      expect(() => service.acceptQuote('missing', INVESTOR, price('1'))).toThrow(NotFoundException);
    });
  });

  describe('retry paths', () => {
    it('accepting twice returns the same accepted quote', () => {
      const q = quote();
      const first = service.acceptQuote(q.quoteId, INVESTOR, price('1000000'));
      clock += 120_000;
      const second = service.acceptQuote(q.quoteId, INVESTOR, price('2000000', 999_999));
      expect(second).toEqual(first);
    });

    it('a stale current price keeps the quote open for a retry', () => {
      const q = quote();
      expect(codeOf(() => service.acceptQuote(q.quoteId, INVESTOR, price('1000000', 30_001)))).toBe(
        'STALE_PRICE',
      );
      expect(service.getQuote(q.quoteId).status).toBe('open');
      expect(service.acceptQuote(q.quoteId, INVESTOR, price('1000000')).status).toBe('accepted');
    });

    it('expireDue sweeps only open quotes past expiry', () => {
      const a = quote();
      const b = quote();
      service.acceptQuote(b.quoteId, INVESTOR, price('1000000'));
      clock += 60_000;
      expect(service.expireDue()).toBe(1);
      expect(service.getQuote(a.quoteId).status).toBe('expired');
      expect(service.getQuote(b.quoteId).status).toBe('accepted');
      expect(service.expireDue()).toBe(0);
    });
  });

  describe('authorization', () => {
    it('only the quoted investor can accept', () => {
      const q = quote();
      expect(() => service.acceptQuote(q.quoteId, OTHER, price('1000000'))).toThrow(ForbiddenException);
      expect(service.getQuote(q.quoteId).status).toBe('open');
    });
  });

  describe('configuration', () => {
    it('rejects invalid config and applies valid overrides', () => {
      expect(() => service.configure({ quoteTtlMs: 0 })).toThrow(BadRequestException);
      expect(() => service.configure({ maxPriceAgeMs: -1 })).toThrow(BadRequestException);
      service.configure({ quoteTtlMs: 5_000 });
      expect(quote().expiresAt).toBe(clock + 5_000);
    });
  });
});
