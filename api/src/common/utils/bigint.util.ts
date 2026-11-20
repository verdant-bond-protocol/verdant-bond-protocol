/**
 * Convert a BigInt to a number if it's within safe integer range,
 * otherwise throw an error. Use for values that MUST fit in a number.
 */
export function toSafeNumber(value: bigint | number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(num)) {
    throw new RangeError(
      `Value ${value} exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER})`,
    );
  }
  return num;
}

/**
 * Convert a BigInt to a string representation. Use for values that
 * may exceed Number.MAX_SAFE_INTEGER and need to be serialized.
 */
export function toBigIntString(value: bigint | number): string {
  return BigInt(value).toString();
}

/**
 * Safe conversion that returns string if value exceeds safe integer range,
 * otherwise returns number. Useful for API responses where both formats
 * may be acceptable.
 */
export function toFlexibleNumber(value: bigint | number): number | string {
  const bigintValue = BigInt(value);
  const num = Number(bigintValue);
  if (Number.isSafeInteger(num) && bigintValue === BigInt(num)) {
    return num;
  }
  return bigintValue.toString();
}

/**
 * Largest amount a Soroban `i128` token balance can hold (2^127 - 1). Any
 * minor-unit amount above this can never be settled on-chain, so the API
 * rejects it at the boundary instead of quoting a number nobody can pay.
 */
export const I128_MAX = (1n << 127n) - 1n;

/**
 * Longest minor-unit string accepted on the wire. `I128_MAX` is 39 digits;
 * the extra headroom tolerates zero-padded clients while still bounding the
 * cost of parsing an attacker-supplied string.
 */
export const MAX_MINOR_UNITS_STRING_LENGTH = 64;

const MINOR_UNITS_PATTERN = /^\d+$/;

/**
 * Parse a wire-format minor-unit amount. Returns `null` (never throws, never
 * rounds) unless `value` is a base-10 digit string of bounded length whose
 * value fits in a non-negative `i128`. JSON numbers are rejected outright:
 * by the time a number reaches us `JSON.parse` may already have rounded it.
 */
export function parseMinorUnits(value: unknown): bigint | null {
  if (
    typeof value !== 'string' ||
    value.length > MAX_MINOR_UNITS_STRING_LENGTH ||
    !MINOR_UNITS_PATTERN.test(value)
  ) {
    return null;
  }
  const parsed = BigInt(value);
  return parsed <= I128_MAX ? parsed : null;
}
