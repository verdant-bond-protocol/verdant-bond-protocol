import { checkRowSafety, IMPORT_LIMITS, ImportPayloadError, parseCsv } from './import-safety';
import { QuarantineCode } from './import.interface';

const FIELDS = ['address', 'status', 'note'];

function codes(row: Record<string, unknown>): QuarantineCode[] {
  return checkRowSafety(row, FIELDS).map((r) => r.code);
}

describe('parseCsv', () => {
  it('parses quoted fields containing commas, quotes and newlines', () => {
    const rows = parseCsv('address,note\r\nA,"hello, ""world""\nsecond line"\r\nB,plain\r\n');
    expect(rows).toEqual([
      { line: 2, row: { address: 'A', note: 'hello, "world"\nsecond line' }, error: null },
      { line: 4, row: { address: 'B', note: 'plain' }, error: null },
    ]);
  });

  it('strips a UTF-8 BOM, maps empty cells to null and ignores blank lines', () => {
    const rows = parseCsv('﻿address,note\nA,\n\n');
    expect(rows).toEqual([{ line: 2, row: { address: 'A', note: null }, error: null }]);
  });

  it('reports a column-count mismatch on the row instead of re-aligning it', () => {
    const rows = parseCsv('address,note\nA,x,shifted\nB,y');
    expect(rows[0]).toEqual({ line: 2, row: null, error: 'expected 2 columns, found 3' });
    expect(rows[1].row).toEqual({ address: 'B', note: 'y' });
  });

  it.each([
    ['unterminated quote', 'address,note\nA,"never closed\nB,x', /unterminated/],
    ['duplicate header', 'address,address\nA,B', /repeats column/],
    ['reserved header', '__proto__,address\nx,A', /reserved name/],
    ['empty header', 'address,,note\nA,B,C', /empty column/],
    ['empty file', '', /empty/],
  ])('refuses the whole file on %s', (_name, csv, message) => {
    expect(() => parseCsv(csv)).toThrow(ImportPayloadError);
    expect(() => parseCsv(csv)).toThrow(message);
  });

  it('refuses files over the row limit', () => {
    const csv = 'address\n' + 'A\n'.repeat(IMPORT_LIMITS.MAX_ROWS + 1);
    expect(() => parseCsv(csv)).toThrow(/more than/);
  });

  it('refuses files over the byte limit', () => {
    const csv = 'address\n' + 'A'.repeat(IMPORT_LIMITS.MAX_PAYLOAD_BYTES);
    expect(() => parseCsv(csv)).toThrow(/exceeds/);
  });
});

describe('checkRowSafety', () => {
  it('accepts a clean row', () => {
    expect(codes({ address: 'GABC', status: 'verified', note: null })).toEqual([]);
  });

  it.each(['=HYPERLINK("http://evil")', '+1+cmd', '@SUM(A1)', '-2+3', '\tx', '=1'])(
    'flags formula injection in %j',
    (value) => {
      // Tab/CR are also unsafe characters; either way the row is quarantined.
      expect(codes({ note: value }).some((c) => c === QuarantineCode.FORMULA_INJECTION || c === QuarantineCode.UNSAFE_CHARACTERS)).toBe(true);
    },
  );

  it('allows plain signed numbers that start with + or -', () => {
    expect(codes({ note: '-5' })).toEqual([]);
    expect(codes({ note: '+12.50' })).toEqual([]);
  });

  it.each(['G‮ABC', 'G​ABC', 'G\u0000ABC', 'G\u0085ABC', '﻿GABC'])('flags unsafe characters in %j', (value) => {
    expect(codes({ address: value })).toEqual([QuarantineCode.UNSAFE_CHARACTERS]);
  });

  it('flags prototype-pollution keys that JSON.parse creates as own properties', () => {
    const row = JSON.parse('{"__proto__": {"admin": true}, "address": "G"}');
    expect(codes(row)).toEqual([QuarantineCode.FORBIDDEN_KEY]);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('flags unknown columns, non-scalar values, oversized and non-finite values', () => {
    expect(codes({ extra: 'x' })).toEqual([QuarantineCode.UNKNOWN_FIELD]);
    expect(codes({ note: { nested: true } })).toEqual([QuarantineCode.INVALID_TYPE]);
    expect(codes({ note: ['a'] })).toEqual([QuarantineCode.INVALID_TYPE]);
    expect(codes({ note: true })).toEqual([QuarantineCode.INVALID_TYPE]);
    expect(codes({ note: 'x'.repeat(IMPORT_LIMITS.MAX_FIELD_LENGTH + 1) })).toEqual([QuarantineCode.FIELD_TOO_LONG]);
    expect(codes({ note: Number.NaN })).toEqual([QuarantineCode.INVALID_VALUE]);
  });

  it('reports every problem in a row, never echoing the value', () => {
    const reasons = checkRowSafety({ address: '=cmd', status: 'G‮', bogus: 1 }, FIELDS);
    expect(reasons.map((r) => r.field).sort()).toEqual(['address', 'bogus', 'status']);
    for (const r of reasons) expect(r.message).not.toContain('cmd');
  });
});
