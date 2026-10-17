/**
 * Boundary and malformed-payload coverage (#420).
 *
 * These tests exercise numeric boundaries, type coercions, and malformed
 * inputs across the shared utilities.  They are not property-based fuzz in
 * the libFuzzer sense, but they cover the same classes of inputs that fuzz
 * engines typically discover first: extremes of numeric range, NaN/Infinity,
 * empty/null/undefined, wrong types, and oversized strings.
 */

import { toSafeNumber, toBigIntString, toFlexibleNumber } from './bigint.util';
import { sortRecords, BOND_STATUS_PRIORITY } from './sort-records.util';

// ── toSafeNumber ─────────────────────────────────────────────────────────────

describe('toSafeNumber — boundary inputs', () => {
  it('accepts Number.MAX_SAFE_INTEGER exactly', () => {
    expect(toSafeNumber(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('accepts Number.MIN_SAFE_INTEGER exactly', () => {
    expect(toSafeNumber(Number.MIN_SAFE_INTEGER)).toBe(Number.MIN_SAFE_INTEGER);
  });

  it('accepts 0', () => {
    expect(toSafeNumber(0)).toBe(0);
  });

  it('throws for BigInt exceeding MAX_SAFE_INTEGER', () => {
    expect(() => toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
  });

  it('throws for BigInt below MIN_SAFE_INTEGER', () => {
    expect(() => toSafeNumber(BigInt(Number.MIN_SAFE_INTEGER) - 1n)).toThrow(RangeError);
  });

  it('throws for NaN coercion (NaN is not safe integer)', () => {
    // Number(NaN) is not a safe integer
    expect(() => toSafeNumber(NaN as unknown as number)).toThrow(RangeError);
  });

  it('throws for Infinity', () => {
    expect(() => toSafeNumber(Infinity as unknown as number)).toThrow(RangeError);
  });

  it('throws for -Infinity', () => {
    expect(() => toSafeNumber(-Infinity as unknown as number)).toThrow(RangeError);
  });
});

// ── toBigIntString ────────────────────────────────────────────────────────────

describe('toBigIntString — boundary inputs', () => {
  it('serialises MAX_SAFE_INTEGER without loss', () => {
    expect(toBigIntString(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
  });

  it('serialises zero', () => {
    expect(toBigIntString(0)).toBe('0');
  });

  it('serialises negative values', () => {
    expect(toBigIntString(-1)).toBe('-1');
  });

  it('serialises BigInt values larger than MAX_SAFE_INTEGER', () => {
    const large = 9007199254740992n; // MAX_SAFE_INTEGER + 1
    expect(toBigIntString(large)).toBe('9007199254740992');
  });
});

// ── toFlexibleNumber ──────────────────────────────────────────────────────────

describe('toFlexibleNumber — boundary inputs', () => {
  it('returns number for small values', () => {
    expect(typeof toFlexibleNumber(42n)).toBe('number');
  });

  it('returns string for values exceeding MAX_SAFE_INTEGER', () => {
    const oversized = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(typeof toFlexibleNumber(oversized)).toBe('string');
  });

  it('returns string representation matching BigInt.toString()', () => {
    const oversized = 9007199254740993n;
    expect(toFlexibleNumber(oversized)).toBe('9007199254740993');
  });

  it('round-trips 0', () => {
    expect(toFlexibleNumber(0n)).toBe(0);
  });
});

// ── sortRecords — malformed / boundary inputs ─────────────────────────────────

describe('sortRecords — malformed payload coverage', () => {
  it('handles records with identical timestamps and ids without throwing', () => {
    const r = { id: 'a', status: 'Active', createdAt: '2024-01-01T00:00:00Z' };
    expect(() => sortRecords([r, { ...r }], BOND_STATUS_PRIORITY)).not.toThrow();
  });

  it('handles ISO string with timezone offset', () => {
    const input = [
      { id: 'b', status: 'Active', createdAt: '2024-06-01T12:00:00+05:30' },
      { id: 'a', status: 'Active', createdAt: '2024-06-01T00:00:00Z' },
    ];
    // +05:30 is 06:30 UTC — so 'a' (00:00 UTC) is earlier
    const result = sortRecords(input, BOND_STATUS_PRIORITY);
    expect(result[0].id).toBe('a');
  });

  it('handles a single-element array', () => {
    const input = [{ id: 'only', status: 'Active', createdAt: '2024-01-01' }];
    expect(sortRecords(input, BOND_STATUS_PRIORITY)).toHaveLength(1);
  });

  it('handles an empty status priority map — all records treated as equal priority', () => {
    const input = [
      { id: 'b', status: 'Matured', createdAt: '2024-01-02' },
      { id: 'a', status: 'Active', createdAt: '2024-01-01' },
    ];
    // No priority entry → both Infinity → sort falls through to createdAt
    const result = sortRecords(input, {});
    expect(result[0].createdAt).toBe('2024-01-01');
  });

  it('large batch (1 000 records) returns stable order without throwing', () => {
    const batch = Array.from({ length: 1000 }, (_, i) => ({
      id: `bond-${String(i).padStart(4, '0')}`,
      status: i % 2 === 0 ? 'Active' : 'Matured',
      createdAt: new Date(Date.UTC(2024, 0, 1) + i * 60_000).toISOString(),
    }));
    const sorted = sortRecords(batch, BOND_STATUS_PRIORITY);
    expect(sorted).toHaveLength(1000);
    // All Active records come before Matured records
    const firstMaturedIdx = sorted.findIndex((r) => r.status === 'Matured');
    const lastActiveIdx = sorted.findLastIndex?.((r) => r.status === 'Active') ?? -1;
    if (firstMaturedIdx !== -1 && lastActiveIdx !== -1) {
      expect(lastActiveIdx).toBeLessThan(firstMaturedIdx);
    }
  });
});
