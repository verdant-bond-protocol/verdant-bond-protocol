import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  CouponPreviewInput,
  CouponSchedulePreviewService,
  PaymentsPerYear,
} from './coupon-schedule-preview.service';

describe('CouponSchedulePreviewService (#439)', () => {
  const service = new CouponSchedulePreviewService();

  const input = (overrides: Partial<CouponPreviewInput> = {}): CouponPreviewInput => ({
    bondId: 'bond-1',
    investor: 'GINVESTOR',
    principalMinor: '1000000',
    couponRateBps: 500,
    paymentsPerYear: 2,
    issueDate: '2026-01-31',
    maturityDate: '2027-01-31',
    ...overrides,
  });

  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (err) {
      return (err as { getResponse(): { code?: string } }).getResponse().code;
    }
    return undefined;
  };

  describe('normal path', () => {
    it('builds the semi-annual schedule with principal at maturity', () => {
      const p = service.preview(input());
      expect(p.payments).toEqual([
        { index: 1, date: '2026-07-31', couponMinor: '25000', principalMinor: '0', stub: false },
        { index: 2, date: '2027-01-31', couponMinor: '25000', principalMinor: '1000000', stub: false },
      ]);
      expect(p.totalCouponMinor).toBe('50000');
      expect(p.totalPrincipalMinor).toBe('1000000');
      expect(p.previewHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('clamps month-end dates without drifting', () => {
      const p = service.preview(input({ paymentsPerYear: 4 }));
      expect(p.payments.map((x) => x.date)).toEqual(['2026-04-30', '2026-07-31', '2026-10-31', '2027-01-31']);
    });

    it('prorates a short final period by days', () => {
      const p = service.preview(input({ issueDate: '2026-01-01', maturityDate: '2026-10-01' }));
      expect(p.payments[1]).toEqual({
        index: 2,
        date: '2026-10-01',
        couponMinor: '12500',
        principalMinor: '1000000',
        stub: true,
      });
    });

    it('skips payments on or before the purchase date', () => {
      const p = service.preview(
        input({ issueDate: '2026-01-01', maturityDate: '2026-10-01', purchaseDate: '2026-07-01' }),
      );
      expect(p.payments.map((x) => x.index)).toEqual([2]);
    });

    it('uses exact integer maths for very large principals', () => {
      const p = service.preview(input({ principalMinor: '1000000000000000000000000000000' }));
      expect(p.payments[0].couponMinor).toBe('25000000000000000000000000000');
    });

    it('supports zero-coupon bonds', () => {
      const p = service.preview(input({ couponRateBps: 0 }));
      expect(p.totalCouponMinor).toBe('0');
    });
  });

  describe('determinism', () => {
    it('produces identical previews and hashes for identical input', () => {
      expect(service.preview(input())).toEqual(service.preview(input()));
      expect(new CouponSchedulePreviewService().preview(input()).previewHash).toBe(
        service.preview(input()).previewHash,
      );
    });

    it('changes the hash when any term changes', () => {
      const base = service.preview(input()).previewHash;
      expect(service.preview(input({ couponRateBps: 501 })).previewHash).not.toBe(base);
      expect(service.preview(input({ investor: 'GOTHER' })).previewHash).not.toBe(base);
      expect(service.preview(input({ principalMinor: '1000001' })).previewHash).not.toBe(base);
    });
  });

  describe('failure paths', () => {
    it.each<[string, Partial<CouponPreviewInput>]>([
      ['zero principal', { principalMinor: '0' }],
      ['fractional principal', { principalMinor: '1.5' }],
      ['rate above 100%', { couponRateBps: 10_001 }],
      ['negative rate', { couponRateBps: -1 }],
      ['unsupported frequency', { paymentsPerYear: 3 as unknown as PaymentsPerYear }],
      ['impossible date', { issueDate: '2026-02-30' }],
      ['bad date format', { maturityDate: '31/01/2027' }],
      ['maturity before issue', { maturityDate: '2025-01-31' }],
      ['purchase before issue', { purchaseDate: '2025-12-31' }],
      ['purchase at maturity', { purchaseDate: '2027-01-31' }],
      ['missing investor', { investor: '' }],
    ])('rejects %s', (_label, overrides) => {
      expect(() => service.preview(input(overrides))).toThrow(BadRequestException);
      expect(codeOf(() => service.preview(input(overrides)))).toBe('INVALID_PREVIEW_INPUT');
    });

    it('caps schedule length', () => {
      expect(
        codeOf(() =>
          service.preview(input({ paymentsPerYear: 12, issueDate: '2000-01-01', maturityDate: '2060-01-01' })),
        ),
      ).toBe('PREVIEW_TOO_LONG');
    });
  });

  describe('signing (retry and authorization)', () => {
    it('accepts the signature when the schedule is unchanged, including on retry', () => {
      const p = service.preview(input());
      expect(service.verifyForSigning(input(), p.previewHash, 'GINVESTOR')).toEqual(p);
      expect(service.verifyForSigning(input(), p.previewHash, 'GINVESTOR')).toEqual(p);
    });

    it('rejects when terms changed after preview', () => {
      const p = service.preview(input());
      expect(() => service.verifyForSigning(input({ couponRateBps: 450 }), p.previewHash, 'GINVESTOR')).toThrow(
        ConflictException,
      );
    });

    it('rejects a signer other than the previewed investor', () => {
      const p = service.preview(input());
      expect(() => service.verifyForSigning(input(), p.previewHash, 'GOTHER')).toThrow(ForbiddenException);
    });
  });
});
