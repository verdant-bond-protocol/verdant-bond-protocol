import { createHash } from 'crypto';

/**
 * Versioned event replay for derived projections (issue #572).
 *
 * A projection is a read model derived from an append-only event log. This
 * module rebuilds or resumes one deterministically:
 *
 * - Events carry a `schemaVersion`. Old events are *upcast* one version at a
 *   time to the current shape before a handler sees them. An event newer than
 *   the code, or one with a missing upcaster step, is refused, never guessed.
 * - Events are ordered per aggregate by `sequence`. A repeated sequence is
 *   skipped (idempotent) unless it carries a different id or payload, which is
 *   a conflict. A skipped sequence number is a gap and halts the replay.
 * - A handler that throws is retried up to `maxAttempts`, then the replay
 *   stops at that event with the state before it intact, so it can be resumed.
 * - Snapshots carry a digest and the projection version. A snapshot from
 *   another projection version, or a tampered one, cannot be resumed; the
 *   projection must be rebuilt from the log instead.
 * - `ProjectionStore.rebuild` builds into a staging snapshot and swaps it in
 *   only when the replay completes. A failed rebuild leaves the live
 *   projection untouched, and `rollback` restores the previous one.
 * - Replay and rollback are admin-only.
 */

export interface DomainEvent {
  id: string;
  aggregateId: string;
  /** 1-based, contiguous per aggregate. */
  sequence: number;
  type: string;
  schemaVersion: number;
  occurredAt: string;
  payload: unknown;
}

/** Upgrades a payload by exactly one schema version. Must be pure. */
export type Upcaster = (payload: unknown) => unknown;

export type ReplayErrorCode =
  | 'forbidden'
  | 'invalid_event'
  | 'unknown_version'
  | 'sequence_gap'
  | 'conflicting_duplicate'
  | 'handler_failed'
  | 'checkpoint_mismatch'
  | 'invalid';

export class EventReplayError extends Error {
  constructor(
    public readonly code: ReplayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EventReplayError';
  }
}

export interface ReplayActor {
  id: string;
  isAdmin?: boolean;
}

export interface ProjectionDefinition<S> {
  name: string;
  /** Bump when the projection's logic or state shape changes; forces a rebuild. */
  version: number;
  initial: () => S;
  /** Pure reducers keyed by event type, called with the upcast event. */
  handlers: Record<string, (state: S, event: DomainEvent) => S>;
}

export interface ProjectionSnapshot<S> {
  projection: string;
  version: number;
  states: Record<string, S>;
  /** Last applied sequence per aggregate. */
  positions: Record<string, number>;
  digest: string;
}

export interface ReplayFailure {
  code: ReplayErrorCode;
  message: string;
  eventId?: string;
  aggregateId?: string;
  sequence?: number;
}

export interface ReplayResult<S> {
  status: 'completed' | 'failed';
  /** On failure this is the checkpoint reached before the failing event. */
  snapshot: ProjectionSnapshot<S>;
  applied: number;
  duplicates: number;
  /** Events of a type the projection has no handler for; position still advances. */
  ignored: number;
  failure?: ReplayFailure;
}

export interface ReplayOptions<S> {
  mode?: 'resume' | 'rebuild';
  snapshot?: ProjectionSnapshot<S>;
  maxAttempts?: number;
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const sha256 = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

const snapshotDigest = <S>(snapshot: Omit<ProjectionSnapshot<S>, 'digest'>): string =>
  sha256({
    projection: snapshot.projection,
    version: snapshot.version,
    states: snapshot.states,
    positions: snapshot.positions,
  });

const seal = <S>(snapshot: Omit<ProjectionSnapshot<S>, 'digest'>): ProjectionSnapshot<S> => ({
  ...snapshot,
  digest: snapshotDigest(snapshot),
});

const assertAdmin = (actor: ReplayActor | undefined): void => {
  if (!actor?.isAdmin) throw new EventReplayError('forbidden', 'Event replay requires an admin actor');
};

/** Upgrades old event payloads to the current schema, one version at a time. */
export class UpcasterRegistry {
  private readonly steps = new Map<string, Upcaster>();

  /** `currentVersions` maps each known event type to the schema version handlers expect. */
  constructor(private readonly currentVersions: Record<string, number>) {}

  register(type: string, fromVersion: number, upcaster: Upcaster): this {
    const current = this.currentVersions[type];
    if (current === undefined || fromVersion < 1 || fromVersion >= current) {
      throw new EventReplayError('invalid', `Cannot register an upcaster for ${type}@${fromVersion}`);
    }
    this.steps.set(`${type}@${fromVersion}`, upcaster);
    return this;
  }

  /** Returns a new event at the current schema version; the input is not modified. */
  upcast(event: DomainEvent): DomainEvent {
    const current = this.currentVersions[event.type];
    if (current === undefined) {
      throw new EventReplayError('invalid_event', `Unknown event type ${event.type}`);
    }
    if (event.schemaVersion > current) {
      throw new EventReplayError(
        'unknown_version',
        `${event.type}@${event.schemaVersion} is newer than the supported version ${current}`,
      );
    }
    let payload = clone(event.payload);
    for (let version = event.schemaVersion; version < current; version++) {
      const step = this.steps.get(`${event.type}@${version}`);
      if (!step) {
        throw new EventReplayError('unknown_version', `No upcaster from ${event.type}@${version} to ${version + 1}`);
      }
      payload = step(payload);
    }
    return { ...event, schemaVersion: current, payload };
  }
}

export class EventReplayer {
  constructor(private readonly upcasters: UpcasterRegistry) {}

  /**
   * Replays `events` into a projection. Throws only for caller errors
   * (`forbidden`, `checkpoint_mismatch`, `invalid`); problems in the event data
   * come back as a `failed` result carrying the checkpoint reached.
   */
  replay<S>(
    projection: ProjectionDefinition<S>,
    events: readonly DomainEvent[],
    actor: ReplayActor,
    options: ReplayOptions<S> = {},
  ): ReplayResult<S> {
    assertAdmin(actor);
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new EventReplayError('invalid', 'maxAttempts must be a positive integer');
    }

    const states: Record<string, S> = {};
    const positions: Record<string, number> = {};
    if ((options.mode ?? 'resume') === 'resume' && options.snapshot) {
      const from = options.snapshot;
      if (from.projection !== projection.name || from.version !== projection.version) {
        throw new EventReplayError(
          'checkpoint_mismatch',
          `Snapshot is for ${from.projection}@${from.version}, projection is ${projection.name}@${projection.version}; rebuild instead`,
        );
      }
      if (from.digest !== snapshotDigest(from)) {
        throw new EventReplayError('checkpoint_mismatch', 'Snapshot digest does not match its contents; rebuild instead');
      }
      Object.assign(states, clone(from.states));
      Object.assign(positions, clone(from.positions));
    }

    let applied = 0;
    let duplicates = 0;
    let ignored = 0;
    const checkpoint = (): ProjectionSnapshot<S> =>
      seal({ projection: projection.name, version: projection.version, states: clone(states), positions: { ...positions } });
    const halt = (failure: ReplayFailure): ReplayResult<S> => ({
      status: 'failed',
      snapshot: checkpoint(),
      applied,
      duplicates,
      ignored,
      failure,
    });

    const byAggregate = new Map<string, DomainEvent[]>();
    for (const event of events) {
      const problem = this.validate(event);
      if (problem) return halt({ code: 'invalid_event', message: problem, eventId: event?.id });
      const list = byAggregate.get(event.aggregateId) ?? [];
      list.push(event);
      byAggregate.set(event.aggregateId, list);
    }

    const seen = new Map<string, string>();
    for (const aggregateId of [...byAggregate.keys()].sort()) {
      const ordered = [...(byAggregate.get(aggregateId) as DomainEvent[])].sort((a, b) => a.sequence - b.sequence);
      for (const event of ordered) {
        const where = { eventId: event.id, aggregateId, sequence: event.sequence };

        const key = `${aggregateId}:${event.sequence}`;
        const signature = `${event.id}:${sha256({ type: event.type, schemaVersion: event.schemaVersion, payload: event.payload })}`;
        const prior = seen.get(key);
        if (prior !== undefined) {
          if (prior !== signature) {
            return halt({
              code: 'conflicting_duplicate',
              message: `Sequence ${event.sequence} of ${aggregateId} was delivered twice with different content`,
              ...where,
            });
          }
          duplicates++;
          continue;
        }
        seen.set(key, signature);

        const position = positions[aggregateId] ?? 0;
        if (event.sequence <= position) {
          duplicates++;
          continue;
        }
        if (event.sequence !== position + 1) {
          return halt({
            code: 'sequence_gap',
            message: `Expected sequence ${position + 1} for ${aggregateId} but found ${event.sequence}`,
            ...where,
          });
        }

        let upcast: DomainEvent;
        try {
          upcast = this.upcasters.upcast(event);
        } catch (err) {
          if (err instanceof EventReplayError) return halt({ code: err.code, message: err.message, ...where });
          throw err;
        }

        const handler = projection.handlers[upcast.type];
        if (!handler) {
          positions[aggregateId] = event.sequence;
          ignored++;
          continue;
        }

        const before = states[aggregateId] ?? projection.initial();
        let next: S | undefined;
        let lastError = '';
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            next = handler(clone(before), clone(upcast));
            break;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
        }
        if (next === undefined) {
          return halt({
            code: 'handler_failed',
            message: `${upcast.type} failed after ${maxAttempts} attempt(s): ${lastError}`,
            ...where,
          });
        }
        states[aggregateId] = next;
        positions[aggregateId] = event.sequence;
        applied++;
      }
    }

    return { status: 'completed', snapshot: checkpoint(), applied, duplicates, ignored };
  }

  private validate(event: DomainEvent): string | undefined {
    if (!event || typeof event !== 'object') return 'Event must be an object';
    if (typeof event.id !== 'string' || !event.id) return 'Event id is required';
    if (typeof event.aggregateId !== 'string' || !event.aggregateId) return `Event ${event.id} has no aggregateId`;
    if (typeof event.type !== 'string' || !event.type) return `Event ${event.id} has no type`;
    if (!Number.isInteger(event.sequence) || event.sequence < 1) {
      return `Event ${event.id} must have a positive integer sequence`;
    }
    if (!Number.isInteger(event.schemaVersion) || event.schemaVersion < 1) {
      return `Event ${event.id} must have a positive integer schemaVersion`;
    }
    return undefined;
  }
}

/**
 * Holds the live snapshot of one projection and makes rebuilds safe: the new
 * snapshot replaces the live one only when the whole replay completes.
 */
export class ProjectionStore<S> {
  private live?: ProjectionSnapshot<S>;
  private previous?: ProjectionSnapshot<S>;

  constructor(
    private readonly projection: ProjectionDefinition<S>,
    private readonly replayer: EventReplayer,
  ) {}

  get snapshot(): ProjectionSnapshot<S> | undefined {
    return this.live;
  }

  /** Applies new events on top of the live snapshot. Progress is kept even when the replay halts. */
  resume(events: readonly DomainEvent[], actor: ReplayActor, maxAttempts?: number): ReplayResult<S> {
    const result = this.replayer.replay(this.projection, events, actor, {
      mode: 'resume',
      snapshot: this.live,
      maxAttempts,
    });
    this.live = result.snapshot;
    return result;
  }

  /**
   * Rebuilds from the full log. On failure the live snapshot is untouched; on
   * success the old one is kept for {@link rollback}.
   */
  rebuild(events: readonly DomainEvent[], actor: ReplayActor, maxAttempts?: number): ReplayResult<S> {
    const result = this.replayer.replay(this.projection, events, actor, { mode: 'rebuild', maxAttempts });
    if (result.status === 'completed') {
      this.previous = this.live;
      this.live = result.snapshot;
    }
    return result;
  }

  /** Restores the snapshot that was live before the last successful rebuild. */
  rollback(actor: ReplayActor): ProjectionSnapshot<S> {
    assertAdmin(actor);
    if (!this.previous) throw new EventReplayError('invalid', 'There is no previous snapshot to roll back to');
    this.live = this.previous;
    this.previous = undefined;
    return this.live;
  }
}
