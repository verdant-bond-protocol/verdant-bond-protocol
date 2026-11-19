import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * Deterministic coupon schedule preview before bond purchase signing (#439).
 *
 * The preview is a pure function of its input: integer-only (bigint) maths,
 * UTC calendar dates, and a fixed field order for the hash. The investor signs
 * over `previewHash`; at signing time the server recomputes the preview and
 * refuses to proceed if anything differs. See docs/coupon-schedule-preview.md.
 */

export const ALLOWED_PAYMENTS_PER_YEAR = [1, 2, 4, 12] as const;
export type PaymentsPerYear = (typeof ALLOWED_PAYMENTS_PER_YEAR)[number];

export const MAX_PREVIEW_PAYMENTS = 600;
export const COUPON_PREVIEW_VERSION = 1;

export interface CouponPreviewInput {
  bondId: string;
  investor: string;
  /** Face value purchased, in minor units. */
  principalMinor: string;
  /** Annual coupon rate in basis points (0..10000). */
  couponRateBps: number;
  paymentsPerYear: PaymentsPerYear;
  /** YYYY-MM-DD, UTC. */
  issueDate: string;
  maturityDate: string;
  /** Defaults to issueDate. Only payments strictly after it are included. */
  purchaseDate?: string;
}

export interface CouponPayment {
  index: number;
  date: string;
  couponMinor: string;
  principalMinor: string;
  /** True when the final period is shorter than a full period (prorated). */
  stub: boolean;
}

export interface CouponSchedulePreview {
  version: number;
  bondId: string;
  investor: string;
  payments: CouponPayment[];
  totalCouponMinor: string;
  totalPrincipalMinor: string;
  previewHash: string;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const DAY_MS = 86_400_000;

function parseDate(field: string, value: string | undefined): number {
  const match = value ? DATE.exec(value) : null;
  if (!match) {
    throw new BadRequestException({ code: 'INVALID_PREVIEW_INPUT', message: `${field} must be YYYY-MM-DD` });
  }
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new BadRequestException({ code: 'INVALID_PREVIEW_INPUT', message: `${field} is not a real date` });
  }
  return ms;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Adds months to a UTC date, clamping to the last day of the target month. */
function addMonths(baseMs: number, months: number): number {
  const base = new Date(baseMs);
  const day = base.getUTCDate();
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay));
}

@Injectable()
export class CouponSchedulePreviewService {
  preview(input: CouponPreviewInput): CouponSchedulePreview {
    if (!input.bondId || !input.investor) {
      throw new BadRequestException({ code: 'INVALID_PREVIEW_INPUT', message: 'bondId and investor are required' });
    }
    if (!POSITIVE_INTEGER.test(input.principalMinor)) {
      throw new BadRequestException({
        code: 'INVALID_PREVIEW_INPUT',
        message: 'principalMinor must be a positive integer string',
      });
    }
    if (!Number.isInteger(input.couponRateBps) || input.couponRateBps < 0 || input.couponRateBps > 10_000) {
      throw new BadRequestException({
        code: 'INVALID_PREVIEW_INPUT',
        message: 'couponRateBps must be an integer between 0 and 10000',
      });
    }
    if (!(ALLOWED_PAYMENTS_PER_YEAR as readonly number[]).includes(input.paymentsPerYear)) {
      throw new BadRequestException({
        code: 'INVALID_PREVIEW_INPUT',
        message: `paymentsPerYear must be one of ${ALLOWED_PAYMENTS_PER_YEAR.join(', ')}`,
      });
    }
    const issue = parseDate('issueDate', input.issueDate);
    const maturity = parseDate('maturityDate', input.maturityDate);
    const purchase = parseDate('purchaseDate', input.purchaseDate ?? input.issueDate);
    if (maturity <= issue) {
      throw new BadRequestException({ code: 'INVALID_PREVIEW_INPUT', message: 'maturityDate must be after issueDate' });
    }
    if (purchase < issue || purchase >= maturity) {
      throw new BadRequestException({
        code: 'INVALID_PREVIEW_INPUT',
        message: 'purchaseDate must be on or after issueDate and before maturityDate',
      });
    }

    const principal = BigInt(input.principalMinor);
    const fullCoupon =
      (principal * BigInt(input.couponRateBps)) / (10_000n * BigInt(input.paymentsPerYear));
    const stepMonths = 12 / input.paymentsPerYear;

    const payments: CouponPayment[] = [];
    let periodStart = issue;
    for (let k = 1; ; k++) {
      if (k > MAX_PREVIEW_PAYMENTS) {
        throw new BadRequestException({ code: 'PREVIEW_TOO_LONG', message: 'Schedule exceeds the maximum length' });
      }
      const scheduled = addMonths(issue, k * stepMonths);
      const isLast = scheduled >= maturity;
      const periodEnd = isLast ? maturity : scheduled;
      let coupon = fullCoupon;
      let stub = false;
      if (isLast && scheduled > maturity) {
        const fullDays = BigInt(Math.round((scheduled - periodStart) / DAY_MS));
        const stubDays = BigInt(Math.round((maturity - periodStart) / DAY_MS));
        coupon = (fullCoupon * stubDays) / fullDays;
        stub = true;
      }
      if (periodEnd > purchase) {
        payments.push({
          index: k,
          date: formatDate(periodEnd),
          couponMinor: coupon.toString(),
          principalMinor: isLast ? principal.toString() : '0',
          stub,
        });
      }
      if (isLast) break;
      periodStart = periodEnd;
    }

    const totalCoupon = payments.reduce((sum, p) => sum + BigInt(p.couponMinor), 0n);
    const body = {
      version: COUPON_PREVIEW_VERSION,
      bondId: input.bondId,
      investor: input.investor,
      payments,
      totalCouponMinor: totalCoupon.toString(),
      totalPrincipalMinor: principal.toString(),
    };
    return { ...body, previewHash: this.hash(body) };
  }

  /**
   * Called when the investor submits a signature. Recomputes the preview and
   * rejects if the signer is not the investor or the hash no longer matches.
   */
  verifyForSigning(input: CouponPreviewInput, previewHash: string, signer: string): CouponSchedulePreview {
    if (signer !== input.investor) {
      throw new ForbiddenException({
        code: 'PREVIEW_SIGNER_MISMATCH',
        message: 'Only the previewed investor can sign this purchase',
      });
    }
    const current = this.preview(input);
    if (current.previewHash !== previewHash) {
      throw new ConflictException({
        code: 'PREVIEW_MISMATCH',
        message: 'Coupon schedule changed since preview; request a new preview before signing',
      });
    }
    return current;
  }

  private hash(body: Omit<CouponSchedulePreview, 'previewHash'>): string {
    // Fixed key order: JSON.stringify follows insertion order, which is set
    // explicitly above and in each payment literal.
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
  }
}
