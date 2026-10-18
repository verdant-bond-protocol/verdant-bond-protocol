/**
 * Deterministic chaos harness (#348).
 *
 * An in-memory stand-in for the @redis/client connection that sits *under*
 * the real RedisService, so production degrade semantics (get -> null,
 * setNx -> false, writes swallowed) are what the workflows actually see.
 * No timers and no wall clock: TTLs run on a manual clock, faults come from a
 * seeded PRNG, so a failing seed reproduces exactly.
 */
import { RedisService } from '../common/services/redis.service';

/** mulberry32: tiny, fast, good enough for fault scheduling. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * - fail:     the request never reaches Redis (connection reset).
 * - lostAck:  the write is applied but the reply is lost (timeout after commit).
 * - stale:    a read returns the value as it was before the last write
 *             (replica lag / read-your-writes violation).
 */
export type Fault = 'fail' | 'lostAck' | 'stale';
export type FaultPlan = (op: string, key: string) => Fault | undefined;

export const noFaults: FaultPlan = () => undefined;

/** Inject `kinds` at `rate` per call, drawn from a seeded stream. */
export function randomFaults(seed: number, rate: number, kinds: Fault[]): FaultPlan {
  const rnd = seededRandom(seed);
  return () => (rnd() < rate ? kinds[Math.floor(rnd() * kinds.length)] : undefined);
}

interface Entry {
  value: string | Set<string>;
  expiresAt?: number;
}

const WRITE_OPS = new Set(['set', 'setEx', 'del', 'sAdd', 'sRem', 'expire', 'incr', 'eval']);

export class ChaosRedisClient {
  nowMs = 0;
  plan: FaultPlan = noFaults;
  readonly injected: Record<Fault, number> = { fail: 0, lostAck: 0, stale: 0 };
  private readonly store = new Map<string, Entry>();
  private readonly previous = new Map<string, Entry | undefined>();

  advance(ms: number): void {
    this.nowMs += ms;
  }

  /** Direct, fault-free view of the store for assertions and operator steps. */
  peek(key: string): string | null {
    const e = this.live(key);
    return e && typeof e.value === 'string' ? e.value : null;
  }

  members(key: string): string[] {
    const e = this.live(key);
    return e && e.value instanceof Set ? [...e.value] : [];
  }

  /** Every live key, sorted, for byte-for-byte comparison of two runs (#390). */
  snapshot(): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const key of [...this.store.keys()].sort()) {
      const e = this.live(key);
      if (!e) continue;
      out[key] = e.value instanceof Set ? [...e.value].sort() : e.value;
    }
    return out;
  }

  forceDelete(key: string): void {
    this.store.delete(key);
  }

  async get(key: string): Promise<string | null> {
    const fault = this.fault('get', key);
    if (fault === 'stale' && this.previous.has(key)) {
      const prev = this.previous.get(key);
      return prev && typeof prev.value === 'string' ? prev.value : null;
    }
    return this.peek(key);
  }

  async set(
    key: string,
    value: string,
    opts?: { NX?: boolean; EX?: number; PX?: number },
  ): Promise<'OK' | null> {
    return this.write('set', key, () => {
      if (opts?.NX && this.live(key)) return null;
      const ttlMs = opts?.PX ?? (opts?.EX ? opts.EX * 1000 : undefined);
      this.put(key, { value, expiresAt: ttlMs !== undefined ? this.nowMs + ttlMs : undefined });
      return 'OK';
    });
  }

  async incr(key: string): Promise<number> {
    return this.write('incr', key, () => {
      const next = Number(this.peek(key) ?? '0') + 1;
      this.put(key, { value: String(next), expiresAt: this.live(key)?.expiresAt });
      return next;
    });
  }

  /**
   * Only the compare-and-delete script RedisService.releaseLockOrThrow sends
   * is modelled; anything else is a harness bug and fails loudly.
   */
  async eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<number> {
    if (!script.includes("redis.call('del'")) throw new Error('chaos: unsupported eval script');
    const [key] = opts.keys;
    return this.write('eval', key, () => {
      if (this.peek(key) !== opts.arguments[0]) return 0;
      this.put(key, undefined);
      return 1;
    });
  }

  async setEx(key: string, seconds: number, value: string): Promise<'OK'> {
    return this.write('setEx', key, () => {
      this.put(key, { value, expiresAt: this.nowMs + seconds * 1000 });
      return 'OK' as const;
    });
  }

  async del(key: string): Promise<number> {
    return this.write('del', key, () => {
      const had = this.live(key) ? 1 : 0;
      this.put(key, undefined);
      return had;
    });
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    return this.write('expire', key, () => {
      const e = this.live(key);
      if (!e) return false;
      this.put(key, { ...e, expiresAt: this.nowMs + seconds * 1000 });
      return true;
    });
  }

  async sAdd(key: string, member: string): Promise<number> {
    return this.write('sAdd', key, () => {
      const set = new Set(this.members(key));
      const added = set.has(member) ? 0 : 1;
      set.add(member);
      this.put(key, { value: set });
      return added;
    });
  }

  async sRem(key: string, member: string): Promise<number> {
    return this.write('sRem', key, () => {
      const set = new Set(this.members(key));
      const removed = set.delete(member) ? 1 : 0;
      this.put(key, { value: set });
      return removed;
    });
  }

  async sMembers(key: string): Promise<string[]> {
    this.fault('sMembers', key);
    return this.members(key);
  }

  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (e?.expiresAt !== undefined && e.expiresAt <= this.nowMs) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  private put(key: string, entry: Entry | undefined): void {
    this.previous.set(key, this.live(key));
    if (entry) this.store.set(key, entry);
    else this.store.delete(key);
  }

  private async write<T>(op: string, key: string, apply: () => T): Promise<T> {
    const fault = this.fault(op, key);
    const result = apply();
    if (fault === 'lostAck') throw new Error(`chaos: lost ack on ${op} ${key}`);
    return result;
  }

  /** Throws for `fail` (before any effect); returns the fault otherwise. */
  private fault(op: string, key: string): Fault | undefined {
    let fault = this.plan(op, key);
    // A lost ack is only meaningful for writes; a stale read only for reads.
    if (fault === 'lostAck' && !WRITE_OPS.has(op)) fault = 'fail';
    if (fault === 'stale' && WRITE_OPS.has(op)) fault = undefined;
    if (!fault) return undefined;
    this.injected[fault]++;
    if (fault === 'fail') throw new Error(`chaos: connection reset on ${op} ${key}`);
    return fault;
  }
}

/** A real RedisService wired to the chaos client instead of a socket. */
export function chaosRedisService(client: ChaosRedisClient): RedisService {
  const service = Object.create(RedisService.prototype);
  Object.assign(service, {
    redis: client,
    healthy: true,
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  return service as RedisService;
}
