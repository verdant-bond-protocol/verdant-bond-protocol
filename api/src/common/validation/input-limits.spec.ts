import { BadRequestException } from '@nestjs/common';
import { assertInputLimits, checkInputLimits, InputLimitsPipe } from './input-limits';

describe('input limits (#540)', () => {
  it('accepts a normal payload', () => {
    expect(checkInputLimits({ bondId: 'b1', amounts: ['100', '200'], meta: { a: 1 } })).toBeNull();
    expect(checkInputLimits(undefined)).toBeNull();
  });

  it('rejects oversized payloads by bytes', () => {
    expect(checkInputLimits({ s: 'x'.repeat(200) }, { maxBytes: 100 })?.code).toBe('payload_too_large');
  });

  it('counts multi-byte characters as bytes', () => {
    expect(checkInputLimits('é'.repeat(30), { maxBytes: 50 })?.code).toBe('payload_too_large');
  });

  it('rejects deep nesting without recursion', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 5000; i += 1) deep = [deep];
    const violation = checkInputLimits(deep, { maxBytes: Number.MAX_SAFE_INTEGER, maxDepth: 12 });
    expect(violation?.code).toBe('too_deep');
    expect(violation?.limit).toBe(12);
  });

  it('rejects long strings with a path', () => {
    expect(checkInputLimits({ a: { b: 'xxxx' } }, { maxStringLength: 3 })).toEqual({
      code: 'string_too_long',
      path: '$.a.b',
      limit: 3,
      actual: 4,
    });
  });

  it('rejects long object keys', () => {
    expect(checkInputLimits({ ['k'.repeat(10)]: 1 }, { maxStringLength: 5 })?.code).toBe('string_too_long');
  });

  it('enforces array and key cardinality', () => {
    expect(checkInputLimits({ holders: new Array(11).fill(1) }, { maxArrayLength: 10 })?.code).toBe('array_too_long');
    const wide: Record<string, number> = {};
    for (let i = 0; i < 11; i += 1) wide[`k${i}`] = i;
    expect(checkInputLimits(wide, { maxObjectKeys: 10 })?.code).toBe('too_many_keys');
  });

  it('enforces total node count', () => {
    const payload = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 1));
    expect(checkInputLimits(payload, { maxTotalNodes: 50 })?.code).toBe('too_many_nodes');
  });

  it('allows exactly-at-limit values', () => {
    expect(checkInputLimits(new Array(10).fill(0), { maxArrayLength: 10 })).toBeNull();
    expect(checkInputLimits('abc', { maxStringLength: 3 })).toBeNull();
  });

  it('flags unserializable input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(checkInputLimits(circular)?.code).toBe('unserializable');
  });

  it('assertInputLimits throws a 400 with the violation', () => {
    expect(() => assertInputLimits({ a: 'xx' }, { maxStringLength: 1 })).toThrow(BadRequestException);
  });

  it('pipe only checks bodies', () => {
    const pipe = new InputLimitsPipe({ maxStringLength: 1 });
    expect(pipe.transform('long', { type: 'query' })).toBe('long');
    expect(() => pipe.transform('long', { type: 'body' })).toThrow(BadRequestException);
  });
});
