/**
 * Property tests for boundary numeric and timestamp values.
 *
 * Deterministic by design: every property runs a seeded stream of inputs
 * (plus an explicit set of extremes), so a failure is reproducible from the
 * seed printed in the test name. No external fuzz library or wall clock is
 * required — `npm test` runs these alongside the rest of the suite.
 */

import {
  I128_MAX,
  MAX_MINOR_UNITS_STRING_LENGTH,
  parseMinorUnits,
  toBigIntString,
  toFlexibleNumber,
  toSafeNumber,
} from '../common/utils/bigint.util';
import {
  ArchiveState,
  activeLifecycle,
  archiveRecord,
  isArchived,
  restoreRecord,
} from '../common/lifecycle/record-lifecycle';
import { PartialFailureService } from '../failures/partial-failure.service';
import { StatusService } from '../status/status.service';
import { seededRandom } from '../test/chaos.harness';

const ITERATIONS = 250;
const MAX_JS_TIME = 8.64e15; // Date's representable range

function seededBigints(seed: number): bigint[] {
  const rnd = seededRandom(seed);
  const values: bigint[] = [
    0n,
    1n,
    -1n,
    BigInt(Number.MAX_SAFE_INTEGER - 1),
    BigInt(Number.MAX_SAFE_INTEGER),
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    I128_MAX,
    I128_MAX + 1n,
    1n << 200n,
  ];
  for (let i = 0; i < ITERATIONS; i++) {
    const bits = 1 + Math.floor(rnd() * 200);
    let value = 0n;
    for (let b = 0; b < bits; b++) value = (value << 1n) | (rnd() < 0.5 ? 0n : 1n);
    values.push(rnd() < 0.5 ? value : -value);
  }
  return values;
}

describe('numeric boundary properties', () => {
  it('toBigIntString and toFlexibleNumber round-trip every generated value exactly', () => {
    for (const value of seededBigints(0xC0FFEE)) {
      const text = toBigIntString(value);
      expect(BigInt(text)).toBe(value);
      expect(BigInt(String(toFlexibleNumber(value)))).toBe(value);

      const flexible = toFlexibleNumber(value);
      const isSafe = value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER);
      expect(typeof flexible).toBe(isSafe ? 'number' : 'string');
    }
  });

  it('toSafeNumber accepts only values inside the safe integer band', () => {
    for (const value of seededBigints(0xB0A5)) {
      const inRange = value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER);
      if (inRange) {
        expect(toSafeNumber(value)).toBe(Number(value));
      } else {
        expect(() => toSafeNumber(value)).toThrow(RangeError);
      }
    }
    expect(() => toSafeNumber(Number.NaN)).toThrow(RangeError);
    expect(() => toSafeNumber(Infinity)).toThrow(RangeError);
  });

  it('parseMinorUnits never rounds, never throws, and rejects every out-of-contract string', () => {
    const rnd = seededRandom(0xA11CE);
    for (let i = 0; i < ITERATIONS; i++) {
      const digits = 1 + Math.floor(rnd() * (MAX_MINOR_UNITS_STRING_LENGTH - 1));
      let text = '';
      for (let d = 0; d < digits; d++) text += String(Math.floor(rnd() * 10));
      const value = BigInt(text);
      const parsed = parseMinorUnits(text);
      if (value <= I128_MAX) {
        expect(parsed).toBe(value);
      } else {
        expect(parsed).toBeNull();
      }
    }
    for (const bad of ['', '1.5', '-1', ' 12', '12 ', '0x10', '1_000', '9'.repeat(MAX_MINOR_UNITS_STRING_LENGTH + 1), 12 as unknown as string]) {
      expect(parseMinorUnits(bad)).toBeNull();
    }
    expect(parseMinorUnits(toBigIntString(I128_MAX))).toBe(I128_MAX);
    expect(parseMinorUnits(toBigIntString(I128_MAX + 1n))).toBeNull();
  });
});

describe('timestamp boundary properties', () => {
  function makeStatus() {
    const status = new StatusService(
      { isHealthy: () => true } as any,
      { findMany: jest.fn(async () => ({ data: [], meta: {} })) } as any,
    );
    return status;
  }

  it('scheduleMaintenance rejects non-finite and inverted windows at every boundary', () => {
    const status = makeStatus();
    const now = 0;
    const invalid: Array<[string, string]> = [
      ['not-a-date', new Date(1000).toISOString()],
      [new Date(1000).toISOString(), 'not-a-date'],
      [new Date(1000).toISOString(), new Date(1000).toISOString()],
      [new Date(2000).toISOString(), new Date(1000).toISOString()],
      ['Infinity', new Date(2000).toISOString()],
    ];
    // These are malformed; all of them must be refused rather than producing
    // a NaN window that later poisons the feed.
    for (const [startsAt, endsAt] of invalid) {
      expect(() => status.scheduleMaintenance('bad window', startsAt, endsAt, 'GADMIN', now)).toThrow(
        expect.objectContaining({ code: 'invalid_window' }),
      );
    }
  });

  it('getPublicStatus and trendExport stay well-formed from epoch zero to the Date limit', async () => {
    const rnd = seededRandom(0x71AE5);
    const clocks = [0, 1, -1, MAX_JS_TIME, MAX_JS_TIME - 1];
    for (let i = 0; i < ITERATIONS; i++) clocks.push(Math.floor(rnd() * MAX_JS_TIME));

    const failures = new PartialFailureService();
    for (const now of [0, 1_000, MAX_JS_TIME - 1]) {
      failures.record({
        operationType: 'payout.distribution',
        message: 'boundary sample',
        now,
      });
    }

    for (const now of clocks) {
      const value = await makeStatus().getPublicStatus(now);
      expect(value.generatedAt).toBe(new Date(now).toISOString());
      expect(Number.isNaN(Date.parse(value.generatedAt))).toBe(false);
    }

    const export1 = failures.trendExport({ bucketMs: 1_000, now: MAX_JS_TIME });
    for (const bucket of export1.buckets) {
      expect(Date.parse(bucket.bucketStart)).toBeLessThanOrEqual(Date.parse(bucket.bucketEnd));
      expect(bucket.total).toBe(
        bucket.archived + bucket.byStatus.open + bucket.byStatus.retrying + bucket.byStatus.resolved,
      );
    }
    // Boundary failures neither vanish nor get duplicated into an extra bucket.
    expect(export1.buckets.reduce((sum, b) => sum + b.total, 0)).toBe(3);
  });
});

describe('lifecycle transition properties', () => {
  it('a seeded sequence of archive/restore transitions keeps every invariant', () => {
    const rnd = seededRandom(0x11FE);
    for (let run = 0; run < 40; run++) {
      const lifecycle = activeLifecycle();
      let expectedArchived = false;
      let transitions = 0;
      const times = [0, 1, MAX_JS_TIME - 1];

      for (let step = 0; step < 12; step++) {
        const archive = rnd() < 0.5;
        const now = step < 3 ? times[step] : Math.floor(rnd() * MAX_JS_TIME);
        if (archive && !expectedArchived) {
          archiveRecord(lifecycle, { actor: `actor-${step}`, reason: `reason-${step}`, now });
          expectedArchived = true;
          transitions++;
        } else if (!archive && expectedArchived) {
          restoreRecord(lifecycle, { actor: `actor-${step}`, now });
          expectedArchived = false;
          transitions++;
        }

        expect(isArchived({ lifecycle })).toBe(expectedArchived);
        expect(lifecycle.state).toBe(expectedArchived ? ArchiveState.Archived : ArchiveState.Active);
        expect(lifecycle.history).toHaveLength(transitions);
        expect(lifecycle.history.every((e) => typeof e.actor === 'string' && e.actor.length > 0)).toBe(true);
        expect(lifecycle.history.every((e) => Number.isFinite(Date.parse(e.at)))).toBe(true);
      }
    }
  });
});
