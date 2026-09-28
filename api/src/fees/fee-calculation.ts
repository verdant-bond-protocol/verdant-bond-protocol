/**
 * Deterministic fee calculation with an explainable line-item breakdown
 * (issue #301).
 *
 * All math is done in `bigint` over the asset's minor units (never
 * floating point), so the same input schedule and amount always produce the
 * exact same output — no drift between two runs, two processes, or two
 * different JS engines. Every line item records the code, the basis points
 * applied, and the resulting minor-unit amount, so the breakdown can be
 * reconciled line-by-line against a stored settlement record rather than
 * only checked by its total.
 */

/** One fee schedule entry: a basis-point rate with an optional floor/ceiling. */
export interface FeeScheduleLine {
  /** Stable identifier for this fee, used to key the corresponding line item. */
  code: string;
  /** Human-readable label shown in the breakdown. */
  label: string;
  /** Rate in basis points (1 bps = 0.01%). Must be an integer in [0, 10_000]. */
  basisPoints: number;
  /** Minimum charge for this line, in the asset's minor units, if the schedule defines one. */
  minFeeMinorUnits?: bigint;
  /** Maximum charge for this line, in the asset's minor units, if the schedule defines one. */
  maxFeeMinorUnits?: bigint;
}

/** One computed line in a fee breakdown. */
export interface FeeLineItem {
  code: string;
  label: string;
  basisPoints: number;
  /** The rate applied to the input amount, before any min/max clamp. */
  rawAmountMinorUnits: string;
  /** The amount actually charged for this line, after any min/max clamp. */
  amountMinorUnits: string;
  /** Set when `minFeeMinorUnits` or `maxFeeMinorUnits` changed the raw amount. */
  clamped: 'min' | 'max' | null;
}

export interface FeeBreakdown {
  inputAmountMinorUnits: string;
  assetDecimals: number;
  lines: FeeLineItem[];
  /** Sum of every line's `amountMinorUnits`. */
  totalFeeMinorUnits: string;
  /** `inputAmountMinorUnits - totalFeeMinorUnits`, floored at zero. */
  netAmountMinorUnits: string;
}

export class InvalidFeeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFeeInputError';
  }
}

/** Widest asset precision this calculator accepts, matching Stellar's own ceiling. */
const MAX_ASSET_DECIMALS = 18;

function assertValidAssetDecimals(assetDecimals: number): void {
  if (
    !Number.isInteger(assetDecimals) ||
    assetDecimals < 0 ||
    assetDecimals > MAX_ASSET_DECIMALS
  ) {
    throw new InvalidFeeInputError(
      `assetDecimals must be an integer in [0, ${MAX_ASSET_DECIMALS}], got ${assetDecimals}`,
    );
  }
}

function parseAmount(amount: bigint | string, field: string): bigint {
  let value: bigint;
  try {
    value = typeof amount === 'bigint' ? amount : BigInt(amount);
  } catch {
    throw new InvalidFeeInputError(`${field} must be an integer amount in minor units, got "${amount}"`);
  }
  if (value < 0n) {
    throw new InvalidFeeInputError(`${field} must not be negative, got ${value}`);
  }
  return value;
}

function assertValidBasisPoints(line: FeeScheduleLine): void {
  if (!Number.isInteger(line.basisPoints) || line.basisPoints < 0 || line.basisPoints > 10_000) {
    throw new InvalidFeeInputError(
      `fee line "${line.code}": basisPoints must be an integer in [0, 10000], got ${line.basisPoints}`,
    );
  }
}

/**
 * Round-half-up at the minor-unit boundary: `(amount * bps + 5000) / 10000`
 * using integer division. Basis points only ever divide by exactly 10,000,
 * so this is exact — there is no float rounding to reason about, and the
 * same inputs always round the same way.
 */
function applyBasisPoints(amount: bigint, basisPoints: number): bigint {
  return (amount * BigInt(basisPoints) + 5_000n) / 10_000n;
}

/**
 * Compute a deterministic, explainable fee breakdown for `amountMinorUnits`
 * under `schedule`. Throws {@link InvalidFeeInputError} for a malformed
 * amount, schedule, or `assetDecimals` rather than silently producing a
 * misleading number.
 */
export function calculateFees(
  amountMinorUnits: bigint | string,
  schedule: readonly FeeScheduleLine[],
  assetDecimals: number,
): FeeBreakdown {
  assertValidAssetDecimals(assetDecimals);
  const amount = parseAmount(amountMinorUnits, 'amountMinorUnits');

  const seenCodes = new Set<string>();
  const lines: FeeLineItem[] = schedule.map((line) => {
    assertValidBasisPoints(line);
    if (seenCodes.has(line.code)) {
      throw new InvalidFeeInputError(`duplicate fee schedule code "${line.code}"`);
    }
    seenCodes.add(line.code);

    const raw = applyBasisPoints(amount, line.basisPoints);
    let clamped: 'min' | 'max' | null = null;
    let charged = raw;
    if (line.minFeeMinorUnits !== undefined && charged < line.minFeeMinorUnits) {
      charged = line.minFeeMinorUnits;
      clamped = 'min';
    }
    if (line.maxFeeMinorUnits !== undefined && charged > line.maxFeeMinorUnits) {
      charged = line.maxFeeMinorUnits;
      clamped = 'max';
    }

    return {
      code: line.code,
      label: line.label,
      basisPoints: line.basisPoints,
      rawAmountMinorUnits: raw.toString(),
      amountMinorUnits: charged.toString(),
      clamped,
    };
  });

  const totalFeeRaw = lines.reduce((sum, line) => sum + BigInt(line.amountMinorUnits), 0n);
  // Fees can never take more than the amount they are levied on, however the
  // schedule is configured (e.g. several uncapped high-bps lines stacked
  // together): clamp the total, not any individual line, so each line still
  // reports what its own rate would have charged in isolation.
  const totalFee = totalFeeRaw > amount ? amount : totalFeeRaw;
  const net = amount - totalFee;

  return {
    inputAmountMinorUnits: amount.toString(),
    assetDecimals,
    lines,
    totalFeeMinorUnits: totalFee.toString(),
    netAmountMinorUnits: net.toString(),
  };
}
