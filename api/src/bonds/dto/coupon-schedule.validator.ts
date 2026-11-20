import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

// Mirrors frontend/src/app/shared/validators/coupon-schedule.validators.ts.
// The contract (contracts/bond-issuer/src/lib.rs) only rejects an empty
// schedule and coupon dates >= maturity_date; it does not check ordering,
// duplicates, or past dates. This validator closes that gap at the API
// layer so requests fail fast with a clear message before reaching the
// contract call. All values are epoch seconds (u64 on-chain).
@ValidatorConstraint({ name: 'isValidCouponSchedule', async: false })
export class IsValidCouponScheduleConstraint implements ValidatorConstraintInterface {
  validate(couponSchedule: unknown, args: ValidationArguments): boolean {
    if (!Array.isArray(couponSchedule) || couponSchedule.length === 0) return false;
    if (!couponSchedule.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;

    const maturityDate = (args.object as { maturityDate?: unknown }).maturityDate;
    if (typeof maturityDate !== 'number' || !Number.isFinite(maturityDate)) return true; // maturityDate's own validator reports that error

    const nowSeconds = Math.floor(Date.now() / 1000);
    for (let i = 0; i < couponSchedule.length; i++) {
      const date = couponSchedule[i];
      if (date <= nowSeconds) return false;
      if (date >= maturityDate) return false;
      if (i > 0 && date <= couponSchedule[i - 1]) return false; // strictly ascending, no duplicates
    }
    return true;
  }

  defaultMessage(): string {
    return 'couponSchedule must be non-empty, strictly ascending, in the future, and every date must be before maturityDate';
  }
}

export function IsValidCouponSchedule(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidCouponScheduleConstraint,
    });
  };
}
