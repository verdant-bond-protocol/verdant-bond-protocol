/**
 * Credit quantity formatting utilities (#157).
 *
 * On-chain credit quantities are expressed in minor units (credit * 10^decimals,
 * where every registered credit type uses 6 decimals — see `CreditType::decimals`
 * in contracts/shared/src/types.rs). The API returns these values as raw
 * minor-unit strings so no rounding is lost in transit; the frontend is
 * responsible for turning them into human-readable major units for display.
 */

/** Minor units per whole credit (10^6 = 1,000,000, matching on-chain credit types). */
export const CREDIT_MINOR_UNITS = 1_000_000;

/**
 * Format a minor-unit credit quantity (string or number, matching the on-chain
 * 6-decimal representation) as a human-readable string in major units.
 *
 * Rounding uses truncation so the displayed value never overstates what is
 * actually claimable on-chain (mirrors the contract's own sweep behaviour).
 */
export function formatCreditMinorUnits(
  minorUnits: string | number | bigint,
  maxDecimals = 2,
): string {
  const whole = Number(minorUnits);
  if (!Number.isFinite(whole) || whole < 0) return '0';
  const major = whole / CREDIT_MINOR_UNITS;
  if (maxDecimals <= 0) return String(Math.trunc(major));
  const factor = 10 ** maxDecimals;
  return String(Math.trunc(major * factor) / factor);
}
