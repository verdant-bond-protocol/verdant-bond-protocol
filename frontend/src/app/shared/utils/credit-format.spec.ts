import { formatCreditMinorUnits, CREDIT_MINOR_UNITS } from './credit-format';

describe('formatCreditMinorUnits (#157)', () => {
  it('converts whole credits from minor units', () => {
    expect(formatCreditMinorUnits(String(5 * CREDIT_MINOR_UNITS))).toBe('5');
  });

  it('renders fractional credits with the default 2 decimals', () => {
    expect(formatCreditMinorUnits('1500000')).toBe('1.5');
    expect(formatCreditMinorUnits('1123456')).toBe('1.12');
  });

  it('accedes number and bigint inputs', () => {
    expect(formatCreditMinorUnits(250)).toBe('0');
    expect(formatCreditMinorUnits(BigInt(9000000))).toBe('9');
  });

  it('truncates rather than rounds so it never overstates claimable value', () => {
    expect(formatCreditMinorUnits('1299999')).toBe('1.29');
    expect(formatCreditMinorUnits(1999999)).toBe('1.99');
  });

  it('honours a custom max decimals', () => {
    expect(formatCreditMinorUnits('1234567', 4)).toBe('1.2345');
    expect(formatCreditMinorUnits('1234567', 0)).toBe('1');
  });

  it('returns 0 for negative or non-finite input', () => {
    expect(formatCreditMinorUnits('-1000000')).toBe('0');
    expect(formatCreditMinorUnits('not-a-number')).toBe('0');
  });
});
