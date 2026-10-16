import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  assertLedgerPayload,
  computeCheckpointMac,
  computeEventHash,
  MIN_CHECKPOINT_KEY_LENGTH,
  serializeNdjson,
  sha256Hex,
  verifyLedgerEvents,
} from './ledger.chain';
import { createLedgerStoreFromEnv, LEDGER_STORE, LedgerStore } from './ledger.store';
import {
  LEDGER_EVENT_TYPES,
  LEDGER_GENESIS_HASH,
  LEDGER_SCHEMA_VERSION,
  LedgerCategory,
  LedgerCheckpoint,
  LedgerEvent,
  LedgerEventInput,
  LedgerEventType,
  LedgerExport,
  LedgerVerificationReport,
} from './ledger.types';

/**
 * In-memory working set bound. Reached, appends are refused rather than old
 * events evicted: eviction would rewrite an append-only history.
 */
export const MAX_LEDGER_EVENTS = 100_000;
export const MAX_EXPORT_EVENTS = 10_000;
export const DEFAULT_CHECKPOINT_INTERVAL = 100;
const MAX_FIELD_LENGTH = 256;

export class LedgerSealedError extends ServiceUnavailableException {
  constructor(reason: string) {
    super(`event ledger is sealed: ${reason}`);
  }
}

export interface LedgerQuery {
  fromSequence?: number;
  limit?: number;
  category?: LedgerCategory;
  type?: LedgerEventType;
  subjectType?: string;
  subjectId?: string;
}

export interface LedgerStatus {
  headSequence: number;
  headHash: string;
  sealed: boolean;
  sealedReason: string | null;
  appendFailures: number;
  checkpointing: 'enabled' | 'disabled';
  checkpointInterval: number;
  lastCheckpoint: LedgerCheckpoint | null;
  capacity: number;
}

/**
 * Tamper-evident, chronological ledger of privileged and financial events.
 *
 * - One global SHA-256 hash chain (`ledger.chain.ts`); every event commits to
 *   its predecessor, so altering, dropping, inserting or reordering any event
 *   breaks verification from that point on.
 * - Appends are serialised through a promise queue: sequence numbers are
 *   assigned in call order, and the in-memory head only advances after the
 *   store accepted the event, so a failed write never leaves a gap.
 * - Every `checkpointInterval` events, an HMAC checkpoint of the head is
 *   stored. Storage-level attackers who recompute every hash still cannot
 *   forge checkpoints without `LEDGER_CHECKPOINT_KEY`.
 * - On startup the stored chain is verified. If it does not verify the
 *   ledger SEALS: it refuses appends (so nothing new is chained onto a
 *   corrupted history) until an operator recovers it (docs/event-ledger.md).
 *
 * There is intentionally no HTTP append endpoint: events are emitted by the
 * services that perform the privileged or financial action, never by clients.
 */
@Injectable()
export class EventLedgerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventLedgerService.name);
  private readonly store: LedgerStore;
  private events: LedgerEvent[] = [];
  private checkpoints: LedgerCheckpoint[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private loaded: Promise<void> | null = null;
  private needsReload = false;
  private sealedReason: string | null = null;
  private appendFailures = 0;

  /** Test seam for deterministic timestamps. */
  clock: () => Date = () => new Date();
  checkpointInterval = positiveInt(process.env.LEDGER_CHECKPOINT_INTERVAL, DEFAULT_CHECKPOINT_INTERVAL);

  constructor(@Optional() @Inject(LEDGER_STORE) store?: LedgerStore) {
    this.store = store ?? createLedgerStoreFromEnv();
  }

  async onModuleInit(): Promise<void> {
    await this.enqueue(() => this.ensureLoaded());
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue;
    await this.store.close();
  }

  /** Append an event; rejects on validation, sealing, capacity or storage failure. */
  append(input: LedgerEventInput): Promise<LedgerEvent> {
    return this.enqueue(() => this.appendNow(input));
  }

  /**
   * Best-effort append for hooks inside existing business flows: never
   * rejects, so adding ledger coverage cannot change a flow's behaviour.
   * Failures are logged and counted in `getStatus().appendFailures`, which
   * operators alert on.
   */
  async appendSafe(input: LedgerEventInput): Promise<LedgerEvent | null> {
    try {
      return await this.append(input);
    } catch (error) {
      this.appendFailures++;
      this.logger.error(
        `ledger append failed for ${input?.type} ${input?.subjectType}:${input?.subjectId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  query(filter: LedgerQuery = {}): Promise<LedgerEvent[]> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const from = filter.fromSequence ?? 1;
      const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1_000);
      const out: LedgerEvent[] = [];
      for (let i = Math.max(from - 1, 0); i < this.events.length && out.length < limit; i++) {
        const e = this.events[i];
        if (filter.category && e.category !== filter.category) continue;
        if (filter.type && e.type !== filter.type) continue;
        if (filter.subjectType && e.subjectType !== filter.subjectType) continue;
        if (filter.subjectId && e.subjectId !== filter.subjectId) continue;
        out.push(clone(e));
      }
      return out;
    });
  }

  /**
   * Re-read the store and verify it against this process's own view of the
   * head. Catches tampering done to storage after startup (including tail
   * truncation, which a hash chain alone cannot reveal).
   */
  verify(): Promise<LedgerVerificationReport> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const [stored, checkpoints] = await Promise.all([this.store.loadEvents(), this.store.loadCheckpoints()]);
      const head = this.head();
      return verifyLedgerEvents(stored, {
        checkpoints,
        checkpointKeys: this.verificationKeys(),
        lostKeyIds: lostKeyIds(),
        expectedHeadHash: head.hash,
        expectedLastSequence: head.sequence,
      });
    });
  }

  /** Create a checkpoint at the current head (idempotent per sequence). */
  createCheckpoint(): Promise<LedgerCheckpoint> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.assertNotSealed();
      return this.checkpointNow();
    });
  }

  /**
   * Export an inclusive sequence range as NDJSON plus a manifest that lets a
   * third party verify it offline. The export itself is ledgered.
   */
  export(options: { fromSequence?: number; toSequence?: number; exportedBy: string }): Promise<LedgerExport> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const headSeq = this.events.length;
      const from = options.fromSequence ?? 1;
      const to = Math.min(options.toSequence ?? headSeq, headSeq);
      if (!Number.isInteger(from) || from < 1) throw new BadRequestException('fromSequence must be a positive integer');
      if (!Number.isInteger(to)) throw new BadRequestException('toSequence must be an integer');
      if (headSeq > 0 && from > to) throw new BadRequestException('fromSequence must be <= toSequence');
      if (to - from + 1 > MAX_EXPORT_EVENTS) {
        throw new BadRequestException(`export at most ${MAX_EXPORT_EVENTS} events per request; page by sequence`);
      }
      if (!options.exportedBy) throw new BadRequestException('exportedBy is required');

      const slice = headSeq === 0 ? [] : this.events.slice(from - 1, to);
      const ndjson = serializeNdjson(slice);
      const anchorHash = slice.length ? slice[0].previousHash : this.head().hash;
      const manifest = {
        format: 'verdant-ledger-ndjson' as const,
        schemaVersion: LEDGER_SCHEMA_VERSION,
        fromSequence: slice.length ? from : 0,
        toSequence: slice.length ? to : 0,
        count: slice.length,
        anchorHash,
        headHash: slice.length ? slice[slice.length - 1].hash : anchorHash,
        exportedAt: this.clock().toISOString(),
        exportedBy: options.exportedBy,
        bodySha256: sha256Hex(ndjson),
        checkpoints: this.checkpoints.filter((c) => c.sequence >= from && c.sequence <= to).map((c) => ({ ...c })),
      };

      // Exports of a sealed ledger are allowed (they are how evidence is
      // preserved during recovery) but cannot themselves be recorded.
      if (!this.sealedReason) {
        await this.appendNow({
          type: 'ledger.exported',
          actor: options.exportedBy,
          subjectType: 'ledger',
          subjectId: 'global',
          payload: {
            fromSequence: manifest.fromSequence,
            toSequence: manifest.toSequence,
            headHash: manifest.headHash,
            bodySha256: manifest.bodySha256,
          },
        });
      }
      return { manifest, ndjson };
    });
  }

  getStatus(): LedgerStatus {
    const head = this.head();
    return {
      headSequence: head.sequence,
      headHash: head.hash,
      sealed: this.sealedReason !== null,
      sealedReason: this.sealedReason,
      appendFailures: this.appendFailures,
      checkpointing: this.checkpointKey() ? 'enabled' : 'disabled',
      checkpointInterval: this.checkpointInterval,
      lastCheckpoint: this.checkpoints.length ? { ...this.checkpoints[this.checkpoints.length - 1] } : null,
      capacity: MAX_LEDGER_EVENTS,
    };
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.needsReload) {
      this.needsReload = false;
      this.loaded = null;
    }
    if (!this.loaded) {
      this.loaded = this.load().catch((error) => {
        this.loaded = null;
        throw error;
      });
    }
    await this.loaded;
  }

  private async load(): Promise<void> {
    await this.store.init();
    const [events, checkpoints] = await Promise.all([this.store.loadEvents(), this.store.loadCheckpoints()]);
    const report = verifyLedgerEvents(events, {
      checkpoints,
      checkpointKeys: this.verificationKeys(),
      lostKeyIds: lostKeyIds(),
    });
    this.events = events;
    this.checkpoints = checkpoints;
    if (!report.ok) {
      const first = report.failures[0];
      this.sealedReason = `stored chain failed verification at sequence ${first.sequence}: ${first.reason} (${report.failures.length} failure(s))`;
      this.logger.error(this.sealedReason);
    } else {
      this.sealedReason = null;
    }
  }

  private async appendNow(input: LedgerEventInput): Promise<LedgerEvent> {
    await this.ensureLoaded();
    this.assertNotSealed();
    const validated = this.validate(input);
    if (this.events.length >= MAX_LEDGER_EVENTS) {
      throw new ServiceUnavailableException(`event ledger at capacity (${MAX_LEDGER_EVENTS} events)`);
    }

    const head = this.head();
    const last = this.events[this.events.length - 1];
    // Never let ledger time go backwards (NTP step, VM migration). Business
    // time stays in `occurredAt` untouched.
    let recordedAt = this.clock().toISOString();
    if (last && recordedAt < last.recordedAt) recordedAt = last.recordedAt;

    const unhashed: Omit<LedgerEvent, 'hash'> = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      sequence: head.sequence + 1,
      eventId: randomUUID(),
      category: LEDGER_EVENT_TYPES[validated.type],
      type: validated.type,
      actor: validated.actor,
      subjectType: validated.subjectType,
      subjectId: validated.subjectId,
      payload: validated.payload ?? {},
      correlationId: validated.correlationId ?? null,
      occurredAt: validated.occurredAt ?? recordedAt,
      recordedAt,
      previousHash: head.hash,
    };
    const event: LedgerEvent = { ...unhashed, hash: computeEventHash(unhashed) };

    try {
      await this.store.appendEvent(event);
    } catch (error) {
      // The write may or may not have committed (timeout after commit, or a
      // second writer took this sequence). Re-read before the next append
      // instead of guessing.
      this.needsReload = true;
      throw new ServiceUnavailableException(`ledger store rejected event: ${(error as Error).message}`);
    }
    this.events.push(event);

    if (this.checkpointKey() && event.sequence % this.checkpointInterval === 0) {
      try {
        await this.checkpointNow();
      } catch (error) {
        // The event is durable; a missed checkpoint only widens the window
        // the next checkpoint covers.
        this.logger.warn(`checkpoint at ${event.sequence} failed: ${(error as Error).message}`);
      }
    }
    return clone(event);
  }

  private async checkpointNow(): Promise<LedgerCheckpoint> {
    const key = this.checkpointKey();
    if (!key) throw new ServiceUnavailableException('checkpointing disabled (LEDGER_CHECKPOINT_KEY)');
    const last = this.events[this.events.length - 1];
    if (!last) throw new BadRequestException('cannot checkpoint an empty ledger');
    const existing = this.checkpoints.find((c) => c.sequence === last.sequence);
    if (existing) return { ...existing };

    const base = {
      sequence: last.sequence,
      hash: last.hash,
      recordedAt: last.recordedAt,
      createdAt: this.clock().toISOString(),
      keyId: process.env.LEDGER_CHECKPOINT_KEY_ID || 'v1',
    };
    const checkpoint: LedgerCheckpoint = { ...base, mac: computeCheckpointMac(base, key) };
    await this.store.appendCheckpoint(checkpoint);
    this.checkpoints.push(checkpoint);
    return { ...checkpoint };
  }

  private validate(input: LedgerEventInput): LedgerEventInput {
    if (!input || typeof input !== 'object') throw new BadRequestException('event is required');
    if (!Object.prototype.hasOwnProperty.call(LEDGER_EVENT_TYPES, input.type)) {
      throw new BadRequestException(`unknown ledger event type: ${String(input.type)}`);
    }
    for (const field of ['actor', 'subjectType', 'subjectId'] as const) {
      const value = input[field];
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_FIELD_LENGTH) {
        throw new BadRequestException(`${field} must be a non-empty string of at most ${MAX_FIELD_LENGTH} chars`);
      }
    }
    if (input.correlationId !== undefined && (typeof input.correlationId !== 'string' || input.correlationId.length > MAX_FIELD_LENGTH)) {
      throw new BadRequestException('correlationId must be a string');
    }
    let occurredAt: string | undefined;
    if (input.occurredAt !== undefined) {
      const ms = Date.parse(input.occurredAt);
      if (typeof input.occurredAt !== 'string' || Number.isNaN(ms)) throw new BadRequestException('occurredAt must be an ISO-8601 timestamp');
      occurredAt = new Date(ms).toISOString();
    }
    const payload = input.payload ?? {};
    try {
      assertLedgerPayload(payload);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    // Deep copy: the caller may mutate its object after we hashed it.
    return { ...input, payload: JSON.parse(JSON.stringify(payload)), occurredAt };
  }

  private assertNotSealed(): void {
    if (this.sealedReason) throw new LedgerSealedError(this.sealedReason);
  }

  private head(): { sequence: number; hash: string } {
    const last = this.events[this.events.length - 1];
    return last ? { sequence: last.sequence, hash: last.hash } : { sequence: 0, hash: LEDGER_GENESIS_HASH };
  }

  private checkpointKey(): string | null {
    const key = process.env.LEDGER_CHECKPOINT_KEY ?? '';
    return key.length >= MIN_CHECKPOINT_KEY_LENGTH ? key : null;
  }

  /**
   * Current key plus retired keys (`LEDGER_CHECKPOINT_RETIRED_KEYS`, as
   * `id:key,id:key`) so checkpoints survive key rotation. Undefined when no
   * key is configured, which skips MAC checks rather than failing them all.
   */
  private verificationKeys(): Record<string, string> | undefined {
    const keys: Record<string, string> = {};
    for (const pair of (process.env.LEDGER_CHECKPOINT_RETIRED_KEYS ?? '').split(',')) {
      const idx = pair.indexOf(':');
      if (idx > 0) keys[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
    const current = this.checkpointKey();
    if (current) keys[process.env.LEDGER_CHECKPOINT_KEY_ID || 'v1'] = current;
    return Object.keys(keys).length ? keys : undefined;
  }
}

/** `LEDGER_CHECKPOINT_LOST_KEY_IDS`: comma-separated ids of keys that are gone. */
function lostKeyIds(): string[] {
  return (process.env.LEDGER_CHECKPOINT_LOST_KEY_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
