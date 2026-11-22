import { ConflictException } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiProblemException } from '../common/errors/problem-exception';
import { QuoteConversionService } from './quote-conversion.service';
import { StaticTestRateSource } from './static-rate.source';

describe('QuoteConversionService (#620)', () => {
  let rateSource: StaticTestRateSource;
  let service: QuoteConversionService;

  const ACCOUNT_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const ACCOUNT_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  beforeEach(() => {
    rateSource = new StaticTestRateSource();
    service = new QuoteConversionService(rateSource, {
      ttlMs: 30_000,
      maxRateAgeMs: 60_000,
      maxSlippageBps: 100,
      maxAmountMinorUnits: 10n ** 18n,
      maxRateValue: 10n ** 15n,
    });
  });

  it('issues a quote and consumes it within TTL', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    rateSource.setRate({
      baseCurrency: 'USD',
      quoteCurrency: 'XLM',
      rateNumerator: '25000000',
      rateDenominator: '10000000',
      scale: 7,
      referenceRateNumerator: '25000000',
      referenceRateDenominator: '10000000',
      source: 'test-feed',
      observedAt: t0,
    });

    const quote = await service.issueQuote({
      baseCurrency: 'USD',
      quoteCurrency: 'XLM',
      amount: '1000',
      account: ACCOUNT_A,
      purpose: 'bond_subscription',
      now: t0,
    });

    expect(quote.status).toBe('open');
    expect(quote.convertedAmount).toBe('2500');
    expect(quote.dust).toBe('0');
    expect(quote.roundingRule).toBe('floor');

    const result = await service.consumeQuote({
      quoteId: quote.id,
      account: ACCOUNT_A,
      purpose: 'bond_subscription',
      now: new Date(t0.getTime() + 10_000),
    });

    expect(result.quote.status).toBe('used');
    expect(result.convertedAmount).toBe('2500');
    expect(result.idempotentReplay).toBe(false);
  });

  it('rejects quote consumption after TTL expiry', async () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const quote = await service.issueQuote({
      baseCurrency: 'USD',
      quoteCurrency: 'XLM',
      amount: '1000',
      account: ACCOUNT_A,
      purpose: 'bond_subscription',
      now: t0,
    });

    await expect(
      service.consumeQuote({
        quoteId: quote.id,
        account: ACCOUNT_A,
        purpose: 'bond_subscription',
        now: new Date(t0.getTime() + 30_001),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.QUOTE_EXPIRED });

    expect(service.getQuote(quote.id).status).toBe('expired');
  });

  it('rejects double use and allows only one winner under concurrent requests', async () => {
    const t0 = new Date();
    const quote = await service.issueQuote({
      baseCurrency: 'USD',
      quoteCurrency: 'XLM',
      amount: '1000',
      account: ACCOUNT_A,
      purpose: 'bond_subscription',
      now: t0,
    });

    const [r1, r2, r3] = await Promise.allSettled([
      service.consumeQuote({ quoteId: quote.id, account: ACCOUNT_A, purpose: 'bond_subscription', now: t0 }),
      service.consumeQuote({ quoteId: quote.id, account: ACCOUNT_A, purpose: 'bond_subscription', now: t0 }),
      service.consumeQuote({ quoteId: quote.id, account: ACCOUNT_A, purpose: 'bond_subscription', now: t0 }),
    ]);

    const fulfilled = [r1, r2, r3].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2, r3].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const err of rejected) {
      expect((err.reason as ApiProblemException).code).toBe(ErrorCode.QUOTE_ALREADY_USED);
    }
  });

  it('rejects consumption by wrong account or wrong purpose', async () => {
    const t0 = new Date();
    const quote = await service.issueQuote({
      baseCurrency: 'USD',
      quoteCurrency: 'XLM',
      amount: '1000',
      account: ACCOUNT_A,
      purpose: 'bond_subscription',
      now: t0,
    });

    await expect(
      service.consumeQuote({
        quoteId: quote.id,
        account: ACCOUNT_B,
        purpose: 'bond_subscription',
        now: t0,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.QUOTE_BINDING_MISMATCH });

    await expect(
      service.consumeQuote({
        quoteId: quote.id,
        account: ACCOUNT_A,
        purpose: 'redemption',
        now: t0,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.QUOTE_BINDING_MISMATCH });
  });

  it('rejects quotes exceeding max slippage against reference rate', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    rateSource.setRate({
      baseCurrency: 'USD',
      quoteCurrency: 'XLM',
      rateNumerator: '10500000',
      rateDenominator: '10000000',
      scale: 7,
      referenceRateNumerator: '10000000',
      referenceRateDenominator: '10000000',
      source: 'test-feed',
      observedAt: now,
    });

    await expect(
      service.issueQuote({
        baseCurrency: 'USD',
        quoteCurrency: 'XLM',
        amount: '1000',
        account: ACCOUNT_A,
        purpose: 'secondary_trade',
        now,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.QUOTE_SLIPPAGE_EXCEEDED });
  });

  it('fails closed when rate source data is stale', async () => {
    const now = new Date('2026-01-01T00:05:00.000Z');
    const staleObservedAt = new Date(now.getTime() - 60_001);
    rateSource.setRate({
      baseCurrency: 'USD',
      quoteCurrency: 'XLM',
      rateNumerator: '10000000',
      rateDenominator: '10000000',
      scale: 7,
      referenceRateNumerator: '10000000',
      referenceRateDenominator: '10000000',
      source: 'stale-feed',
      observedAt: staleObservedAt,
    });

    await expect(
      service.issueQuote({
        baseCurrency: 'USD',
        quoteCurrency: 'XLM',
        amount: '1000',
        account: ACCOUNT_A,
        purpose: 'bond_subscription',
        now,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.STALE_RATE_SOURCE });
  });

  it('floors fractional outputs, tracks dust, and prevents round-trip value gain', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    rateSource.setRate({
      baseCurrency: 'USD',
      quoteCurrency: 'XLM',
      rateNumerator: '1',
      rateDenominator: '3',
      scale: 7,
      referenceRateNumerator: '1',
      referenceRateDenominator: '3',
      source: 'test-feed',
      observedAt: now,
    });
    rateSource.setRate({
      baseCurrency: 'XLM',
      quoteCurrency: 'USD',
      rateNumerator: '3',
      rateDenominator: '1',
      scale: 7,
      referenceRateNumerator: '3',
      referenceRateDenominator: '1',
      source: 'test-feed',
      observedAt: now,
    });

    const leg1 = await service.issueQuote({
      baseCurrency: 'USD',
      quoteCurrency: 'XLM',
      amount: '100',
      account: ACCOUNT_A,
      purpose: 'secondary_trade',
      now,
    });

    expect(leg1.convertedAmount).toBe('33');
    expect(leg1.dust).toBe('1');

    const leg2 = await service.issueQuote({
      baseCurrency: 'XLM',
      quoteCurrency: 'USD',
      amount: leg1.convertedAmount,
      account: ACCOUNT_A,
      purpose: 'secondary_trade',
      now,
    });

    expect(BigInt(leg2.convertedAmount)).toBeLessThanOrEqual(100n);
    expect(leg2.convertedAmount).toBe('99');
  });

  it('rejects zero, negative, non-integer, and absurdly large amounts', async () => {
    const now = new Date();
    for (const invalid of ['0', '-100', '12.34', 'abc', (10n ** 19n).toString()]) {
      await expect(
        service.issueQuote({
          baseCurrency: 'USD',
          quoteCurrency: 'XLM',
          amount: invalid,
          account: ACCOUNT_A,
          purpose: 'bond_subscription',
          now,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    }
  });

  it('returns the same result on retry with the same idempotency key and rejects mismatched payloads', async () => {
    const now = new Date();
    const q1 = await service.issueQuote({
      baseCurrency: 'USD',
      quoteCurrency: 'XLM',
      amount: '1000',
      account: ACCOUNT_A,
      purpose: 'bond_subscription',
      idempotencyKey: 'issue-key-1',
      now,
    });
    const q2 = await service.issueQuote({
      baseCurrency: 'USD',
      quoteCurrency: 'XLM',
      amount: '1000',
      account: ACCOUNT_A,
      purpose: 'bond_subscription',
      idempotencyKey: 'issue-key-1',
      now,
    });
    expect(q2.id).toBe(q1.id);

    await expect(
      service.issueQuote({
        baseCurrency: 'USD',
        quoteCurrency: 'XLM',
        amount: '2000',
        account: ACCOUNT_A,
        purpose: 'bond_subscription',
        idempotencyKey: 'issue-key-1',
        now,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const c1 = await service.consumeQuote({
      quoteId: q1.id,
      account: ACCOUNT_A,
      purpose: 'bond_subscription',
      idempotencyKey: 'consume-key-1',
      now,
    });
    const c2 = await service.consumeQuote({
      quoteId: q1.id,
      account: ACCOUNT_A,
      purpose: 'bond_subscription',
      idempotencyKey: 'consume-key-1',
      now,
    });
    expect(c1.idempotentReplay).toBe(false);
    expect(c2.idempotentReplay).toBe(true);
    expect(c2.quote.id).toBe(q1.id);
  });

  it('rolls back quote consumption if conversion fails halfway', async () => {
    const now = new Date();
    const quote = await service.issueQuote({
      baseCurrency: 'USD',
      quoteCurrency: 'XLM',
      amount: '1000',
      account: ACCOUNT_A,
      purpose: 'coupon_settlement',
      now,
    });

    await expect(
      service.consumeQuote({
        quoteId: quote.id,
        account: ACCOUNT_A,
        purpose: 'coupon_settlement',
        now,
        onBeforeCommit: async () => {
          throw new Error('simulated settlement failure');
        },
      }),
    ).rejects.toThrow('simulated settlement failure');

    const afterRollback = service.getQuote(quote.id);
    expect(afterRollback.status).toBe('open');
    expect(afterRollback.consumedAt).toBeUndefined();

    // Can now be consumed cleanly
    const succeeded = await service.consumeQuote({
      quoteId: quote.id,
      account: ACCOUNT_A,
      purpose: 'coupon_settlement',
      now,
    });
    expect(succeeded.quote.status).toBe('used');
  });
});
