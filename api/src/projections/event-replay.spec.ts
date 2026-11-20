import {
  DomainEvent,
  EventReplayError,
  EventReplayer,
  ProjectionDefinition,
  ProjectionStore,
  UpcasterRegistry,
} from './event-replay';

interface Holding {
  issued: number;
  currency: string;
  redeemed: number;
}

const ADMIN = { id: 'ops', isAdmin: true };
const USER = { id: 'someone' };

let counter = 0;
const evt = (
  aggregateId: string,
  sequence: number,
  type: string,
  payload: unknown,
  schemaVersion = type === 'BondIssued' ? 2 : 1,
): DomainEvent => ({
  id: `e-${++counter}`,
  aggregateId,
  sequence,
  type,
  schemaVersion,
  occurredAt: '2026-01-01T00:00:00.000Z',
  payload,
});

const registry = () =>
  new UpcasterRegistry({ BondIssued: 2, BondRedeemed: 1, Noted: 1 }).register('BondIssued', 1, (payload) => ({
    ...(payload as { amount: number }),
    currency: 'USD',
  }));

const holdings = (version = 1): ProjectionDefinition<Holding> => ({
  name: 'holdings',
  version,
  initial: () => ({ issued: 0, currency: '', redeemed: 0 }),
  handlers: {
    BondIssued: (state, event) => {
      const { amount, currency } = event.payload as { amount: number; currency: string };
      return { ...state, issued: state.issued + amount, currency };
    },
    BondRedeemed: (state, event) => ({
      ...state,
      redeemed: state.redeemed + (event.payload as { amount: number }).amount,
    }),
  },
});

describe('versioned event replay (#572)', () => {
  let replayer: EventReplayer;

  beforeEach(() => {
    counter = 0;
    replayer = new EventReplayer(registry());
  });

  describe('normal path', () => {
    it('builds per-aggregate state from events in sequence order, however they arrive', () => {
      const log = [
        evt('bond-1', 2, 'BondRedeemed', { amount: 30 }),
        evt('bond-2', 1, 'BondIssued', { amount: 50, currency: 'EUR' }),
        evt('bond-1', 1, 'BondIssued', { amount: 100, currency: 'USD' }),
      ];

      const result = replayer.replay(holdings(), log, ADMIN);

      expect(result.status).toBe('completed');
      expect(result.applied).toBe(3);
      expect(result.snapshot.states['bond-1']).toEqual({ issued: 100, currency: 'USD', redeemed: 30 });
      expect(result.snapshot.states['bond-2']).toEqual({ issued: 50, currency: 'EUR', redeemed: 0 });
      expect(result.snapshot.positions).toEqual({ 'bond-1': 2, 'bond-2': 1 });
    });

    it('is deterministic: the same log in any order yields the same digest', () => {
      const log = [
        evt('bond-1', 1, 'BondIssued', { amount: 100, currency: 'USD' }),
        evt('bond-1', 2, 'BondRedeemed', { amount: 30 }),
        evt('bond-2', 1, 'BondIssued', { amount: 5, currency: 'USD' }),
      ];

      const a = replayer.replay(holdings(), log, ADMIN, { mode: 'rebuild' });
      const b = replayer.replay(holdings(), [...log].reverse(), ADMIN, { mode: 'rebuild' });

      expect(a.snapshot.digest).toBe(b.snapshot.digest);
    });

    it('advances past event types the projection ignores', () => {
      const log = [
        evt('bond-1', 1, 'BondIssued', { amount: 10, currency: 'USD' }),
        evt('bond-1', 2, 'Noted', { text: 'hello' }),
        evt('bond-1', 3, 'BondRedeemed', { amount: 4 }),
      ];

      const result = replayer.replay(holdings(), log, ADMIN);

      expect(result.status).toBe('completed');
      expect(result.ignored).toBe(1);
      expect(result.snapshot.states['bond-1'].redeemed).toBe(4);
    });
  });

  describe('schema versions', () => {
    it('upcasts a v1 event to the current shape before the handler sees it', () => {
      const result = replayer.replay(holdings(), [evt('bond-1', 1, 'BondIssued', { amount: 70 }, 1)], ADMIN);

      expect(result.status).toBe('completed');
      expect(result.snapshot.states['bond-1']).toEqual({ issued: 70, currency: 'USD', redeemed: 0 });
    });

    it('does not mutate the stored event while upcasting', () => {
      const stored = evt('bond-1', 1, 'BondIssued', { amount: 70 }, 1);

      registry().upcast(stored);

      expect(stored.schemaVersion).toBe(1);
      expect(stored.payload).toEqual({ amount: 70 });
    });

    it('halts on an event newer than the code supports instead of misreading it', () => {
      const result = replayer.replay(holdings(), [evt('bond-1', 1, 'BondIssued', { amount: 1 }, 3)], ADMIN);

      expect(result.status).toBe('failed');
      expect(result.failure?.code).toBe('unknown_version');
      expect(result.snapshot.states).toEqual({});
    });

    it('halts when a step in the upcast chain is missing', () => {
      const gappy = new EventReplayer(new UpcasterRegistry({ BondIssued: 3 }));

      const result = gappy.replay(holdings(), [evt('bond-1', 1, 'BondIssued', { amount: 1 }, 1)], ADMIN);

      expect(result.failure?.code).toBe('unknown_version');
      expect(result.failure?.message).toMatch(/No upcaster from BondIssued@1/);
    });

    it('halts on an event type nobody registered', () => {
      const result = replayer.replay(holdings(), [evt('bond-1', 1, 'Mystery', {}, 1)], ADMIN);

      expect(result.failure?.code).toBe('invalid_event');
    });

    it('rejects an upcaster registered for a version that is not behind the current one', () => {
      const reg = new UpcasterRegistry({ BondIssued: 2 });
      expect(() => reg.register('BondIssued', 2, (p) => p)).toThrow(EventReplayError);
      expect(() => reg.register('Other', 1, (p) => p)).toThrow(EventReplayError);
    });
  });

  describe('ordering and duplicates', () => {
    it('skips an exact duplicate delivery without applying it twice', () => {
      const first = evt('bond-1', 1, 'BondIssued', { amount: 10, currency: 'USD' });

      const result = replayer.replay(holdings(), [first, { ...first }], ADMIN);

      expect(result.status).toBe('completed');
      expect(result.applied).toBe(1);
      expect(result.duplicates).toBe(1);
      expect(result.snapshot.states['bond-1'].issued).toBe(10);
    });

    it('halts when two different events claim the same sequence', () => {
      const log = [
        evt('bond-1', 1, 'BondIssued', { amount: 10, currency: 'USD' }),
        evt('bond-1', 1, 'BondIssued', { amount: 99, currency: 'USD' }),
      ];

      const result = replayer.replay(holdings(), log, ADMIN);

      expect(result.status).toBe('failed');
      expect(result.failure?.code).toBe('conflicting_duplicate');
    });

    it('halts on a sequence gap and keeps the checkpoint before it', () => {
      const log = [
        evt('bond-1', 1, 'BondIssued', { amount: 10, currency: 'USD' }),
        evt('bond-1', 3, 'BondRedeemed', { amount: 1 }),
      ];

      const result = replayer.replay(holdings(), log, ADMIN);

      expect(result.status).toBe('failed');
      expect(result.failure).toMatchObject({ code: 'sequence_gap', aggregateId: 'bond-1', sequence: 3 });
      expect(result.snapshot.positions['bond-1']).toBe(1);
    });

    it('halts on malformed events', () => {
      const bad = { ...evt('bond-1', 1, 'BondIssued', {}), sequence: 0 };
      expect(replayer.replay(holdings(), [bad], ADMIN).failure?.code).toBe('invalid_event');
      const noAggregate = { ...evt('', 1, 'BondIssued', {}) };
      expect(replayer.replay(holdings(), [noAggregate], ADMIN).failure?.code).toBe('invalid_event');
    });
  });

  describe('retry and resume', () => {
    it('retries a transient handler failure and then succeeds', () => {
      let calls = 0;
      const flaky = holdings();
      const original = flaky.handlers.BondRedeemed;
      flaky.handlers.BondRedeemed = (state, event) => {
        if (++calls < 3) throw new Error('db busy');
        return original(state, event);
      };

      const result = replayer.replay(
        flaky,
        [evt('bond-1', 1, 'BondIssued', { amount: 10, currency: 'USD' }), evt('bond-1', 2, 'BondRedeemed', { amount: 4 })],
        ADMIN,
      );

      expect(result.status).toBe('completed');
      expect(calls).toBe(3);
      expect(result.snapshot.states['bond-1'].redeemed).toBe(4);
    });

    it('stops at a handler that keeps failing, keeping state intact, and resumes once it is fixed', () => {
      const broken = holdings();
      broken.handlers.BondRedeemed = () => {
        throw new Error('bug');
      };
      const log = [
        evt('bond-1', 1, 'BondIssued', { amount: 10, currency: 'USD' }),
        evt('bond-1', 2, 'BondRedeemed', { amount: 4 }),
        evt('bond-1', 3, 'BondRedeemed', { amount: 1 }),
      ];

      const failed = replayer.replay(broken, log, ADMIN, { maxAttempts: 2 });

      expect(failed.status).toBe('failed');
      expect(failed.failure).toMatchObject({ code: 'handler_failed', sequence: 2 });
      expect(failed.snapshot.positions['bond-1']).toBe(1);

      const resumed = replayer.replay(holdings(), log, ADMIN, { mode: 'resume', snapshot: failed.snapshot });

      expect(resumed.status).toBe('completed');
      expect(resumed.duplicates).toBe(1);
      expect(resumed.applied).toBe(2);
      expect(resumed.snapshot.states['bond-1']).toEqual({ issued: 10, currency: 'USD', redeemed: 5 });
    });

    it('does not apply an event twice when resuming from a checkpoint', () => {
      const log = [
        evt('bond-1', 1, 'BondIssued', { amount: 10, currency: 'USD' }),
        evt('bond-1', 2, 'BondRedeemed', { amount: 4 }),
      ];
      const first = replayer.replay(holdings(), log.slice(0, 1), ADMIN);

      const second = replayer.replay(holdings(), log, ADMIN, { snapshot: first.snapshot });

      expect(second.applied).toBe(1);
      expect(second.snapshot.states['bond-1'].redeemed).toBe(4);
    });

    it('does not modify the snapshot it resumes from', () => {
      const first = replayer.replay(holdings(), [evt('bond-1', 1, 'BondIssued', { amount: 10, currency: 'USD' })], ADMIN);
      const before = JSON.stringify(first.snapshot);

      replayer.replay(holdings(), [evt('bond-1', 2, 'BondRedeemed', { amount: 4 })], ADMIN, { snapshot: first.snapshot });

      expect(JSON.stringify(first.snapshot)).toBe(before);
    });

    it('rejects a nonsensical maxAttempts', () => {
      expect(() => replayer.replay(holdings(), [], ADMIN, { maxAttempts: 0 })).toThrow(EventReplayError);
    });
  });

  describe('checkpoint safety', () => {
    const log = () => [evt('bond-1', 1, 'BondIssued', { amount: 10, currency: 'USD' })];

    it('refuses to resume a snapshot taken under another projection version', () => {
      const v1 = replayer.replay(holdings(1), log(), ADMIN);

      expect(() => replayer.replay(holdings(2), log(), ADMIN, { snapshot: v1.snapshot })).toThrow(
        /rebuild instead/,
      );
    });

    it('refuses to resume a snapshot whose contents were altered', () => {
      const snap = replayer.replay(holdings(), log(), ADMIN).snapshot;
      const tampered = { ...snap, states: { 'bond-1': { issued: 1_000_000, currency: 'USD', redeemed: 0 } } };

      expect(() => replayer.replay(holdings(), log(), ADMIN, { snapshot: tampered })).toThrow(/digest/);
    });

    it('rebuild mode ignores the supplied snapshot and starts from scratch', () => {
      const snap = replayer.replay(holdings(1), log(), ADMIN).snapshot;

      const rebuilt = replayer.replay(holdings(2), log(), ADMIN, { mode: 'rebuild', snapshot: snap });

      expect(rebuilt.status).toBe('completed');
      expect(rebuilt.snapshot.version).toBe(2);
      expect(rebuilt.applied).toBe(1);
    });
  });

  describe('authorization', () => {
    it('refuses replay for non-admin and missing actors', () => {
      expect(() => replayer.replay(holdings(), [], USER)).toThrow('Event replay requires an admin actor');
      expect(() => replayer.replay(holdings(), [], undefined as never)).toThrow(EventReplayError);
    });

    it('refuses store operations for non-admins without touching state', () => {
      const store = new ProjectionStore(holdings(), replayer);
      const log = [evt('bond-1', 1, 'BondIssued', { amount: 10, currency: 'USD' })];

      expect(() => store.resume(log, USER)).toThrow(EventReplayError);
      expect(() => store.rebuild(log, USER)).toThrow(EventReplayError);
      expect(() => store.rollback(USER)).toThrow(EventReplayError);
      expect(store.snapshot).toBeUndefined();
    });
  });

  describe('ProjectionStore rebuild and rollback', () => {
    const log = () => [
      evt('bond-1', 1, 'BondIssued', { amount: 10, currency: 'USD' }),
      evt('bond-1', 2, 'BondRedeemed', { amount: 4 }),
    ];

    it('resumes incrementally and keeps partial progress when a replay halts', () => {
      const store = new ProjectionStore(holdings(), replayer);
      const events = log();

      store.resume(events.slice(0, 1), ADMIN);
      const result = store.resume([events[0], { ...events[1], sequence: 5 }], ADMIN);

      expect(result.status).toBe('failed');
      expect(store.snapshot?.positions['bond-1']).toBe(1);
    });

    it('leaves the live projection untouched when a rebuild fails', () => {
      const store = new ProjectionStore(holdings(), replayer);
      store.rebuild(log(), ADMIN);
      const live = store.snapshot;

      const failed = store.rebuild([evt('bond-1', 2, 'BondRedeemed', { amount: 1 })], ADMIN);

      expect(failed.status).toBe('failed');
      expect(store.snapshot).toBe(live);
    });

    it('swaps in a completed rebuild and can roll back to the previous snapshot', () => {
      const store = new ProjectionStore(holdings(), replayer);
      store.rebuild(log(), ADMIN);
      const before = store.snapshot;

      store.rebuild([...log(), evt('bond-1', 3, 'BondRedeemed', { amount: 1 })], ADMIN);
      expect(store.snapshot?.states['bond-1'].redeemed).toBe(5);

      expect(store.rollback(ADMIN)).toBe(before);
      expect(store.snapshot?.states['bond-1'].redeemed).toBe(4);
      expect(() => store.rollback(ADMIN)).toThrow(/no previous snapshot/);
    });
  });
});
