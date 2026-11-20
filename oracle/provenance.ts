import { createHash } from 'node:crypto';

export interface CouponObservation {
  provider: string;
  observedAt: string;
  value: number;
  unit: string;
  sourceId: string;
  raw?: Record<string, unknown>;
}

export interface CouponProvenanceBundle {
  bundleId: string;
  bondId: string;
  couponPeriod: number;
  observations: CouponObservation[];
  calculation: { principal: string; rate: string; coupon: string; formula: string };
  generatedAt: string;
  digest: string;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildCouponProvenance(input: Omit<CouponProvenanceBundle, 'digest'>): CouponProvenanceBundle {
  if (!input.observations.length) throw new Error('At least one oracle observation is required');
  const digestInput = { ...input, observations: [...input.observations].sort((a, b) => a.sourceId.localeCompare(b.sourceId)) };
  return { ...input, digest: digest(digestInput) };
}

export function verifyCouponProvenance(bundle: CouponProvenanceBundle): boolean {
  const { digest: expected, ...unsigned } = bundle;
  return expected === buildCouponProvenance(unsigned).digest;
}

