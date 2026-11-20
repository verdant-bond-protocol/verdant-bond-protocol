import { I128_MAX, MAX_MINOR_UNITS_STRING_LENGTH, parseMinorUnits } from './bigint.util';

describe('parseMinorUnits', () => {
  it('pins I128_MAX to the Soroban i128 ceiling', () => {
    expect(I128_MAX.toString()).toBe('170141183460469231731687303715884105727');
  });

  it.each([
    ['0', 0n],
    ['9007199254740993', 9_007_199_254_740_993n],
    ['000123', 123n],
    [I128_MAX.toString(), I128_MAX],
  ])('accepts %s exactly', (input, expected) => {
    expect(parseMinorUnits(input)).toBe(expected);
  });

  it.each<[string, unknown]>([
    ['a number', 1000],
    ['a bigint', 1000n],
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['a negative string', '-1'],
    ['a decimal string', '1.0'],
    ['an exponent string', '1e3'],
    ['whitespace', ' 1'],
    ['i128 max + 1', (I128_MAX + 1n).toString()],
    ['an over-long string', '0'.repeat(MAX_MINOR_UNITS_STRING_LENGTH) + '1'],
  ])('rejects %s', (_label, input) => {
    expect(parseMinorUnits(input)).toBeNull();
  });
});
