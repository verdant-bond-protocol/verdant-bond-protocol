import { buildCouponProvenance, verifyCouponProvenance } from './provenance';

describe('coupon provenance bundles', () => {
  it('binds observations and calculation inputs to a digest', () => {
    const bundle = buildCouponProvenance({ bundleId: 'b-1', bondId: 'bond-1', couponPeriod: 2, generatedAt: '2026-01-01T00:00:00Z', observations: [{ provider: 'oracle-a', observedAt: '2026-01-01T00:00:00Z', value: 4.2, unit: 'percent', sourceId: 'a' }], calculation: { principal: '1000', rate: '0.042', coupon: '42', formula: 'principal * rate' } });
    expect(verifyCouponProvenance(bundle)).toBe(true);
    expect(verifyCouponProvenance({ ...bundle, calculation: { ...bundle.calculation, coupon: '43' } })).toBe(false);
  });
});

