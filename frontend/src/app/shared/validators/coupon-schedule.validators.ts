import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

/**
 * Parses the raw comma-separated `couponSchedule` control value into epoch
 * seconds. Same parsing used in issue-bond.component.ts's onSubmit(), kept
 * here so the validator and the submit-time transform never drift apart.
 */
export function parseCouponSchedule(raw: unknown): number[] {
  return String(raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => Number(v));
}

/**
 * Converts a `<input type="date">` value to epoch seconds.
 *
 * All schedule/maturity comparisons in this validator and in
 * issue-bond.component.ts operate on epoch seconds, matching the contract's
 * `env.ledger().timestamp()` (contracts/bond-issuer/src/lib.rs) and the
 * coupon schedule values themselves. `Date.getTime()` already normalizes to
 * UTC epoch milliseconds regardless of the browser's local timezone, so
 * dividing by 1000 is a timezone-safe conversion — no separate timezone
 * handling is needed.
 */
export function toEpochSeconds(dateValue: unknown): number | null {
  if (!dateValue) return null;
  const time = new Date(dateValue as string).getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

/**
 * Form-group-level validator enforcing the coupon schedule semantics
 * documented in docs/bond-coupon-schedule.md:
 *  - non-empty
 *  - every date is an integer epoch-seconds value
 *  - every date is strictly after the current time
 *  - every date is strictly before maturityDate
 *  - dates are strictly ascending (this also rules out duplicates)
 *
 * Mirrors api/src/bonds/dto/coupon-schedule.validator.ts so client and
 * server reject the same schedules.
 */
export function couponScheduleGroupValidator(): ValidatorFn {
  return (group: AbstractControl): ValidationErrors | null => {
    const couponScheduleControl = group.get('couponSchedule');
    const maturityDateControl = group.get('maturityDate');
    if (!couponScheduleControl || !maturityDateControl) return null;

    const maturityDate = toEpochSeconds(maturityDateControl.value);
    if (maturityDate === null) return null; // maturityDate's own required validator reports that error

    const dates = parseCouponSchedule(couponScheduleControl.value);
    if (dates.length === 0 || dates.some((d) => !Number.isFinite(d))) {
      return { couponEmpty: true };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      if (date <= nowSeconds) return { couponPast: true };
      if (date >= maturityDate) return { couponAfterMaturity: true };
      if (i > 0 && date <= dates[i - 1]) return { couponUnordered: true };
    }

    return null;
  };
}
