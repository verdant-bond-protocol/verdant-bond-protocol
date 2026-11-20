/**
 * Minimal, dependency-free property-testing harness.
 *
 * The API test suite deliberately has no property-testing framework dependency.
 * This harness provides the two things a property test actually needs:
 *
 *  1. a *seeded* PRNG, so a failing run can be replayed byte-for-byte by CI or
 *     by a maintainer (no `Math.random()` anywhere in a property), and
 *  2. greedy shrinking, so a failure is reported as the smallest input that
 *     still breaks the property instead of a 200-character random state.
 *
 * It is intentionally synchronous/simple; `checkProperty` awaits the predicate
 * so properties may call the async invariant helpers in `domain-invariants`.
 */

export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability?: number): boolean;
  /** Uniform bigint with at most `bits` bits (for large financial values). */
  bigint(bits: number): bigint;
}

/** Mulberry32: 32-bit seeded PRNG, deterministic across Node versions. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('rng.pick() called with an empty list');
      return items[Math.floor(next() * items.length)];
    },
    bool: (probability = 0.5) => next() < probability,
    bigint: (bits: number) => {
      let value = 0n;
      for (let remaining = bits; remaining > 0; remaining -= 8) {
        value = (value << 8n) | BigInt(Math.floor(next() * 256));
      }
      return value;
    },
  };
}

export type Generator<T> = (rng: Rng) => T;
export type Predicate<T> = (input: T) => boolean | Promise<boolean>;

export interface PropertyOptions<T> {
  seed?: number;
  runs?: number;
  /** Return strictly simpler candidates, tried in order, to minimise a failure. */
  shrink?: (input: T) => T[];
}

export interface PropertyFailure<T> {
  input: T;
  error: string;
  /** 1-based index of the generated case that failed. */
  run: number;
  /** Number of successful shrink steps applied to the counterexample. */
  shrinks: number;
}

export interface PropertyResult<T> {
  passed: boolean;
  runs: number;
  seed: number;
  failure?: PropertyFailure<T>;
}

/** Hard cap so a badly-written shrink function cannot hang a test run. */
const MAX_SHRINKS = 100;

export async function checkProperty<T>(
  generate: Generator<T>,
  predicate: Predicate<T>,
  options: PropertyOptions<T> = {},
): Promise<PropertyResult<T>> {
  const seed = options.seed ?? 0x76657264; // "verd"
  const runs = options.runs ?? 100;
  const rng = mulberry32(seed);

  for (let run = 1; run <= runs; run++) {
    const input = generate(rng);
    let error: string | undefined;
    try {
      if (!(await predicate(input))) error = 'predicate returned false';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (error === undefined) continue;

    // Greedy shrink: keep replacing the counterexample while a simpler
    // candidate still fails the same property.
    let smallest = input;
    let shrinks = 0;
    while (shrinks < MAX_SHRINKS) {
      const candidates = options.shrink?.(smallest) ?? [];
      let next: T | undefined;
      for (const candidate of candidates) {
        try {
          if (!(await predicate(candidate))) {
            next = candidate;
            break;
          }
        } catch {
          // A candidate that throws is not a valid shrinking step.
        }
      }
      if (next === undefined) break;
      smallest = next;
      shrinks++;
    }

    return {
      passed: false,
      runs: run,
      seed,
      failure: { input: smallest, error: error!, run, shrinks },
    };
  }

  return { passed: true, runs, seed };
}

/** Convenience assertion with a failure message that includes the seed. */
export async function assertProperty<T>(
  generate: Generator<T>,
  predicate: Predicate<T>,
  options: PropertyOptions<T> = {},
): Promise<void> {
  const result = await checkProperty(generate, predicate, options);
  if (!result.passed) {
    const f = result.failure!;
    throw new Error(
      `Property failed after ${f.run}/${result.runs} cases (seed ${result.seed}, ${f.shrinks} shrinks): ` +
        `${f.error}\nMinimal counterexample: ${JSON.stringify(f.input, replacer)}`,
    );
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}
