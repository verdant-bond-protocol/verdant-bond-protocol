/**
 * Deterministic replay scheduler for concurrent writes and retries (#390).
 *
 * The chaos harness (#348) makes faults reproducible, but concurrent actors
 * still interleave in whatever order the microtask queue happens to produce.
 * This scheduler makes the interleaving itself the test input:
 *
 *   - every Redis command (and any external effect the test gates, such as a
 *     ledger submit) is a yield point: the actor parks on `gate()`;
 *   - once every live actor is parked, the scheduler releases exactly one,
 *     chosen by a seeded PRNG (explore mode) or by a recorded trace (replay);
 *   - each release is appended to `trace`, so a failing seed yields a trace
 *     that replays the same interleaving step for step. A replay that cannot
 *     follow its trace fails with {@link ReplayDivergenceError}, not silently.
 *
 * Timers (lock-retry sleeps) run on Jest's fake clock and are advanced only
 * when no actor is runnable, so time-based retries are deterministic too.
 */
import { ChaosRedisClient, seededRandom } from '../chaos.harness';

export type ReplayMode = { seed: number } | { trace: readonly string[] };

export class ReplayDivergenceError extends Error {
  constructor(
    readonly step: number,
    readonly expected: string | undefined,
    readonly runnable: string[],
  ) {
    super(
      `replay diverged at step ${step}: trace expects ${expected ?? '<end>'}, runnable: [${runnable.join(', ')}]`,
    );
    this.name = 'ReplayDivergenceError';
  }
}

export type ActorOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'hung' };

interface Waiter {
  label: string;
  release: () => void;
}

/** Drain microtasks; setImmediate is left real by the specs. */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

export class ReplayScheduler {
  readonly trace: string[] = [];
  private readonly waiting: Waiter[] = [];
  private readonly seq = new Map<string, number>();
  private readonly rnd?: () => number;
  private readonly script?: readonly string[];

  /** Called after every released step; throw from it to fail fast on an invariant. */
  onStep?: (step: number, label: string) => void;

  constructor(mode: ReplayMode, private readonly maxSteps = 20_000) {
    if ('seed' in mode) this.rnd = seededRandom(mode.seed);
    else this.script = mode.trace;
  }

  /** Park `actor` until the scheduler picks it. Labels are `actor#n:op`. */
  gate(actor: string, op: string): Promise<void> {
    const n = (this.seq.get(actor) ?? 0) + 1;
    this.seq.set(actor, n);
    const label = `${actor}#${n}:${op}`;
    return new Promise<void>((release) => this.waiting.push({ label, release }));
  }

  async run<T>(actors: Record<string, () => Promise<T>>): Promise<Record<string, ActorOutcome<T>>> {
    const outcomes: Record<string, ActorOutcome<T>> = {};
    const live = new Set(Object.keys(actors));
    for (const [name, body] of Object.entries(actors)) {
      outcomes[name] = { kind: 'hung' };
      body().then(
        (value) => ((outcomes[name] = { kind: 'ok', value }), live.delete(name)),
        (error) => ((outcomes[name] = { kind: 'error', error }), live.delete(name)),
      );
    }

    while (live.size > 0) {
      await drain();
      if (this.waiting.length === 0) {
        if (jest.getTimerCount() === 0) break; // every remaining actor is hung
        jest.advanceTimersToNextTimer();
        continue;
      }
      if (this.trace.length >= this.maxSteps) throw new Error(`replay exceeded ${this.maxSteps} steps`);

      // Choose from a canonical (sorted) runnable set so the decision depends
      // only on what is runnable, never on arrival order.
      this.waiting.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
      const index = this.pick();
      const [next] = this.waiting.splice(index, 1);
      this.trace.push(next.label);
      next.release();
      this.onStep?.(this.trace.length, next.label);
    }

    if (this.script && this.trace.length !== this.script.length) {
      throw new ReplayDivergenceError(this.trace.length, this.script[this.trace.length], []);
    }
    return outcomes;
  }

  private pick(): number {
    if (this.rnd) return Math.floor(this.rnd() * this.waiting.length);
    const expected = this.script![this.trace.length];
    const index = this.waiting.findIndex((w) => w.label === expected);
    if (index < 0) {
      throw new ReplayDivergenceError(this.trace.length, expected, this.waiting.map((w) => w.label));
    }
    return index;
  }
}

const GATED = new Set([
  'get', 'set', 'setEx', 'del', 'expire', 'sAdd', 'sRem', 'sMembers', 'incr', 'eval',
]);

/**
 * One actor's connection to the shared store: every command parks on the
 * scheduler first, then runs against the shared {@link ChaosRedisClient}
 * (so seeded faults and the manual TTL clock still apply).
 */
export function gatedClient(store: ChaosRedisClient, scheduler: ReplayScheduler, actor: string): ChaosRedisClient {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || !GATED.has(prop) || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await scheduler.gate(actor, prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
