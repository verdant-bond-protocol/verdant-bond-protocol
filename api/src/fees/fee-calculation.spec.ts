import { calculateFees, FeeScheduleLine, InvalidFeeInputError } from './fee-calculation';

describe('calculateFees', () => {
  it('is deterministic for identical inputs', () => {
    const schedule: FeeScheduleLine[] = [
      { code: 'a', label: 'A', basisPoints: 33 },
      { code: 'b', label: 'B', basisPoints: 17, minFeeMinorUnits: 500n },
    ];
    const first = calculateFees('1234567', schedule, 7);
    const second = calculateFees('1234567', schedule, 7);
    expect(second).toEqual(first);
  });

  it('produces a zero breakdown for an empty schedule (zero fee)', () => {
    const breakdown = calculateFees('1_000_000'.replace(/_/g, ''), [], 7);
    expect(breakdown.lines).toEqual([]);
    expect(breakdown.totalFeeMinorUnits).toBe('0');
    expect(breakdown.netAmountMinorUnits).toBe('1000000');
  });

  it('zero-amount input produces a zero breakdown even with a non-empty schedule', () => {
    const schedule: FeeScheduleLine[] = [{ code: 'a', label: 'A', basisPoints: 100 }];
    const breakdown = calculateFees('0', schedule, 7);
    expect(breakdown.totalFeeMinorUnits).toBe('0');
    expect(breakdown.netAmountMinorUnits).toBe('0');
  });

  it('clamps a line to its minimum fee when the rate would charge less', () => {
    const schedule: FeeScheduleLine[] = [
      { code: 'custody', label: 'Custody', basisPoints: 1, minFeeMinorUnits: 1_000n },
    ];
    // 1 bps of 1000 minor units = 0.1, rounds to 0 — below the 1000-unit floor.
    const breakdown = calculateFees('1000', schedule, 7);
    expect(breakdown.lines[0]).toMatchObject({
      rawAmountMinorUnits: '0',
      amountMinorUnits: '1000',
      clamped: 'min',
    });
    expect(breakdown.totalFeeMinorUnits).toBe('1000');
  });

  it('clamps a line to its maximum fee when the rate would charge more', () => {
    const schedule: FeeScheduleLine[] = [
      { code: 'capped', label: 'Capped', basisPoints: 500, maxFeeMinorUnits: 100n },
    ];
    const breakdown = calculateFees('1_000_000'.replace(/_/g, ''), schedule, 7);
    expect(breakdown.lines[0]).toMatchObject({ amountMinorUnits: '100', clamped: 'max' });
  });

  it('sums multiple lines into an explainable, reconcilable breakdown', () => {
    const schedule: FeeScheduleLine[] = [
      { code: 'platformFee', label: 'Platform fee', basisPoints: 50 },
      { code: 'custodyFee', label: 'Custody fee', basisPoints: 10, minFeeMinorUnits: 10_000n },
    ];
    const amount = '100000000'; // 10 units at 7 decimals
    const breakdown = calculateFees(amount, schedule, 7);

    expect(breakdown.lines).toHaveLength(2);
    const [platform, custody] = breakdown.lines;
    expect(platform.amountMinorUnits).toBe('500000'); // 0.50% of 100,000,000
    expect(custody.amountMinorUnits).toBe('100000'); // 0.10% of 100,000,000

    // The breakdown must reconcile: lines sum to the reported total, and
    // total + net reconstructs the original input exactly — this is the
    // property a stored settlement record would be checked against.
    const linesSum = breakdown.lines.reduce((sum, l) => sum + BigInt(l.amountMinorUnits), 0n);
    expect(linesSum.toString()).toBe(breakdown.totalFeeMinorUnits);
    expect(BigInt(breakdown.totalFeeMinorUnits) + BigInt(breakdown.netAmountMinorUnits)).toBe(BigInt(amount));
  });

  it('rounds half up at the minor-unit boundary, deterministically', () => {
    // 25 bps of 200 = 0.5 exactly -> rounds up to 1, every time.
    const schedule: FeeScheduleLine[] = [{ code: 'a', label: 'A', basisPoints: 25 }];
    const first = calculateFees('200', schedule, 7);
    const second = calculateFees('200', schedule, 7);
    expect(first.lines[0].amountMinorUnits).toBe('1');
    expect(second.lines[0].amountMinorUnits).toBe('1');
  });

  it('never charges more in total fees than the input amount', () => {
    const schedule: FeeScheduleLine[] = [
      { code: 'a', label: 'A', basisPoints: 9000 },
      { code: 'b', label: 'B', basisPoints: 9000 },
    ];
    const breakdown = calculateFees('1000', schedule, 7);
    expect(BigInt(breakdown.totalFeeMinorUnits)).toBeLessThanOrEqual(1000n);
    expect(BigInt(breakdown.netAmountMinorUnits)).toBeGreaterThanOrEqual(0n);
  });

  it('rejects an invalid (out-of-range) asset precision', () => {
    expect(() => calculateFees('1000', [], -1)).toThrow(InvalidFeeInputError);
    expect(() => calculateFees('1000', [], 19)).toThrow(InvalidFeeInputError);
    expect(() => calculateFees('1000', [], 1.5)).toThrow(InvalidFeeInputError);
  });

  it('rejects a malformed or negative amount', () => {
    expect(() => calculateFees('not-a-number', [], 7)).toThrow(InvalidFeeInputError);
    expect(() => calculateFees('-5', [], 7)).toThrow(InvalidFeeInputError);
  });

  it('rejects an out-of-range basis-point rate and a duplicate schedule code', () => {
    expect(() =>
      calculateFees('1000', [{ code: 'a', label: 'A', basisPoints: 10_001 }], 7),
    ).toThrow(InvalidFeeInputError);
    expect(() =>
      calculateFees(
        '1000',
        [
          { code: 'a', label: 'A', basisPoints: 10 },
          { code: 'a', label: 'A again', basisPoints: 20 },
        ],
        7,
      ),
    ).toThrow(InvalidFeeInputError);
  });
});
