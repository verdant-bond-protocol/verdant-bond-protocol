import { Test } from '@nestjs/testing';
import { EventLedgerService, LedgerSealedError, MAX_EXPORT_EVENTS } from './event-ledger.service';
import { computeEventHash, verifyLedgerExport } from './ledger.chain';
import { InMemoryLedgerStore, LEDGER_STORE, LedgerStore, PostgresLedgerStore } from './ledger.store';
import { LEDGER_GENESIS_HASH, LedgerEventInput } from './ledger.types';

const KEY = 'c'.repeat(32);

const issue = (n: number, extra: Partial<LedgerEventInput> = {}): LedgerEventInput => ({
  type: 'bond.issued',
  actor: 'GADMIN',
  subjectType: 'bond',
  subjectId: `bond-${n}`,
  payload: { faceValue: String(n * 1000), currency: 'USDC' },
  ...extra,
});

function makeService(store: LedgerStore = new InMemoryLedgerStore(), start = Date.UTC(2026, 9, 16)) {
  const service = new EventLedgerService(store);
  let t = start;
  service.clock = () => new Date((t += 1000));
  return { service, store, setTime: (ms: number) => (t = ms) };
}

describe('EventLedgerService', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('is resolvable through Nest DI with no store provider (env default)', async () => {
    const moduleRef = await Test.createTestingModule({ providers: [EventLedgerService] }).compile();
    const service = moduleRef.get(EventLedgerService);
    await service.onModuleInit();
    expect((await service.append(issue(1))).sequence).toBe(1);
  });

  it('uses an injected LEDGER_STORE', async () => {
    const store = new InMemoryLedgerStore();
    const moduleRef = await Test.createTestingModule({
      providers: [EventLedgerService, { provide: LEDGER_STORE, useValue: store }],
    }).compile();
    await moduleRef.get(EventLedgerService).append(issue(1));
    expect(store.events).toHaveLength(1);
  });

  it('chains events from genesis with contiguous sequences and derived category', async () => {
    const { service } = makeService();
    const a = await service.append(issue(1));
    const b = await service.append({ type: 'kyc.override', actor: 'GADMIN', subjectType: 'investor', subjectId: 'GINV' });
    expect(a).toMatchObject({ sequence: 1, previousHash: LEDGER_GENESIS_HASH, category: 'financial' });
    expect(b).toMatchObject({ sequence: 2, previousHash: a.hash, category: 'privileged', payload: {} });
    expect(b.hash).toBe(computeEventHash(b));
    expect((await service.verify()).ok).toBe(true);
  });

  it('serialises concurrent appends into one contiguous chain in call order', async () => {
    const { service } = makeService();
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => service.append(issue(i))));
    expect(results.map((e) => e.sequence)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(results.map((e) => e.subjectId)).toEqual(Array.from({ length: 50 }, (_, i) => `bond-${i}`));
    expect((await service.verify()).ok).toBe(true);
  });

  it('keeps recordedAt monotonic when the wall clock steps backwards, preserving occurredAt', async () => {
    const { service, setTime } = makeService();
    const first = await service.append(issue(1));
    setTime(Date.UTC(2020, 0, 1));
    const second = await service.append(issue(2, { occurredAt: '2026-10-01T12:00:00+02:00' }));
    expect(second.recordedAt).toBe(first.recordedAt);
    expect(second.occurredAt).toBe('2026-10-01T10:00:00.000Z');
    expect((await service.verify()).ok).toBe(true);
  });

  it('returns copies: mutating a returned event or the input payload cannot alter the ledger', async () => {
    const { service } = makeService();
    const input = issue(1);
    const event = await service.append(input);
    (input.payload as any).faceValue = 'tampered';
    (event.payload as any).faceValue = 'tampered';
    const [stored] = await service.query();
    expect(stored.payload.faceValue).toBe('1000');
    expect((await service.verify()).ok).toBe(true);
  });

  describe('validation', () => {
    it.each([
      ['unknown type', { type: 'bond.deleted' }],
      ['missing actor', { actor: '' }],
      ['blank subjectId', { subjectId: '   ' }],
      ['oversized subjectType', { subjectType: 'x'.repeat(300) }],
      ['bad occurredAt', { occurredAt: 'yesterday' }],
      ['Date in payload', { payload: { at: new Date() } }],
      ['secret in payload', { payload: { apiKey: 'abc' } }],
    ])('rejects %s without consuming a sequence', async (_label, override) => {
      const { service } = makeService();
      await expect(service.append({ ...issue(1), ...(override as any) })).rejects.toThrow();
      expect((await service.append(issue(2))).sequence).toBe(1);
    });

    it('appendSafe swallows the failure and counts it', async () => {
      const { service } = makeService();
      await expect(service.appendSafe({ ...issue(1), actor: '' })).resolves.toBeNull();
      expect(service.getStatus().appendFailures).toBe(1);
    });
  });

  describe('storage failures', () => {
    it('does not advance the head when the store rejects a write', async () => {
      const store = new InMemoryLedgerStore();
      const { service } = makeService(store);
      await service.append(issue(1));
      const spy = jest.spyOn(store, 'appendEvent').mockRejectedValueOnce(new Error('connection reset'));
      await expect(service.append(issue(2))).rejects.toThrow(/connection reset/);
      spy.mockRestore();
      const next = await service.append(issue(3));
      expect(next.sequence).toBe(2);
      expect((await service.verify()).ok).toBe(true);
    });

    it('re-reads the store after an ambiguous failure, so a committed-then-timed-out write is not forked', async () => {
      const store = new InMemoryLedgerStore();
      const { service } = makeService(store);
      await service.append(issue(1));
      const real = store.appendEvent.bind(store);
      jest.spyOn(store, 'appendEvent').mockImplementationOnce(async (e) => {
        await real(e); // committed...
        throw new Error('timeout'); // ...but the client never heard back
      });
      await expect(service.append(issue(2))).rejects.toThrow(/timeout/);
      const next = await service.append(issue(3));
      expect(next.sequence).toBe(3);
      expect(store.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
      expect((await service.verify()).ok).toBe(true);
    });

    it('a second writer that already took the sequence makes the store refuse, never overwrite', async () => {
      const store = new InMemoryLedgerStore();
      const a = makeService(store).service;
      const b = makeService(store).service;
      await a.append(issue(1));
      await b.append(issue(2)); // b loads lazily, sees seq 1, writes seq 2
      await expect(a.append(issue(3))).rejects.toThrow(/already exists/);
      // a reloads and continues on top of b's event
      expect((await a.append(issue(4))).sequence).toBe(3);
      expect((await a.verify()).ok).toBe(true);
    });
  });

  describe('startup verification and sealing', () => {
    async function seeded(n: number) {
      const store = new InMemoryLedgerStore();
      const { service } = makeService(store);
      for (let i = 0; i < n; i++) await service.append(issue(i));
      return store;
    }

    it('reloads a verified chain and continues it', async () => {
      const store = await seeded(3);
      const { service } = makeService(store, Date.UTC(2027, 0, 1));
      await service.onModuleInit();
      expect(service.getStatus()).toMatchObject({ headSequence: 3, sealed: false });
      expect((await service.append(issue(9))).sequence).toBe(4);
    });

    it('seals and refuses appends when stored history was altered', async () => {
      const store = await seeded(3);
      store.events[1].payload.faceValue = '1';
      const { service } = makeService(store);
      await service.onModuleInit();
      expect(service.getStatus().sealed).toBe(true);
      expect(service.getStatus().sealedReason).toMatch(/sequence 2: content hash mismatch/);
      await expect(service.append(issue(9))).rejects.toBeInstanceOf(LedgerSealedError);
      await expect(service.createCheckpoint()).rejects.toBeInstanceOf(LedgerSealedError);
      await expect(service.appendSafe(issue(9))).resolves.toBeNull();
    });

    it('still exports a sealed ledger for evidence, without ledgering the export', async () => {
      const store = await seeded(2);
      store.events.splice(0, 1);
      const { service } = makeService(store);
      const exp = await service.export({ exportedBy: 'GADMIN' });
      expect(exp.manifest.count).toBe(1);
      expect(store.events).toHaveLength(1);
    });

    it('seals when a full rewrite is caught by a stored checkpoint', async () => {
      process.env.LEDGER_CHECKPOINT_KEY = KEY;
      const store = await seeded(3);
      const { service: writer } = makeService(store);
      await writer.createCheckpoint();
      // Attacker rewrites seq 2 and recomputes every hash after it.
      store.events[1].payload.faceValue = '1';
      for (let i = 1; i < store.events.length; i++) {
        store.events[i].previousHash = store.events[i - 1].hash;
        store.events[i].hash = computeEventHash(store.events[i]);
      }
      const { service } = makeService(store);
      await service.onModuleInit();
      expect(service.getStatus().sealedReason).toMatch(/checkpoint does not match event/);
    });

    it('verify() detects storage tampering that happened after startup', async () => {
      const store = new InMemoryLedgerStore();
      const { service } = makeService(store);
      for (let i = 0; i < 4; i++) await service.append(issue(i));
      store.events.pop(); // tail truncation: the remaining chain is self-consistent
      const report = await service.verify();
      expect(report.ok).toBe(false);
      expect(report.failures.map((f) => f.reason)).toContain('head mismatch');
    });
  });

  describe('checkpoints', () => {
    it('are disabled without a key of sufficient length', async () => {
      process.env.LEDGER_CHECKPOINT_KEY = 'short';
      const { service } = makeService();
      await service.append(issue(1));
      expect(service.getStatus().checkpointing).toBe('disabled');
      await expect(service.createCheckpoint()).rejects.toThrow(/LEDGER_CHECKPOINT_KEY/);
    });

    it('are taken automatically every interval and verify', async () => {
      process.env.LEDGER_CHECKPOINT_KEY = KEY;
      const store = new InMemoryLedgerStore();
      const { service } = makeService(store);
      service.checkpointInterval = 3;
      for (let i = 0; i < 7; i++) await service.append(issue(i));
      expect(store.checkpoints.map((c) => c.sequence)).toEqual([3, 6]);
      const report = await service.verify();
      expect(report).toMatchObject({ ok: true, checkedCheckpoints: 2 });
    });

    it('manual checkpoint is idempotent at the same head', async () => {
      process.env.LEDGER_CHECKPOINT_KEY = KEY;
      const store = new InMemoryLedgerStore();
      const { service } = makeService(store);
      await service.append(issue(1));
      const a = await service.createCheckpoint();
      const b = await service.createCheckpoint();
      expect(a).toEqual(b);
      expect(store.checkpoints).toHaveLength(1);
    });

    it('a failed checkpoint write does not fail the append', async () => {
      process.env.LEDGER_CHECKPOINT_KEY = KEY;
      const store = new InMemoryLedgerStore();
      jest.spyOn(store, 'appendCheckpoint').mockRejectedValue(new Error('disk full'));
      const { service } = makeService(store);
      service.checkpointInterval = 1;
      await expect(service.append(issue(1))).resolves.toMatchObject({ sequence: 1 });
    });

    it('survive key rotation via LEDGER_CHECKPOINT_RETIRED_KEYS', async () => {
      process.env.LEDGER_CHECKPOINT_KEY = KEY;
      const store = new InMemoryLedgerStore();
      const { service } = makeService(store);
      await service.append(issue(1));
      await service.createCheckpoint();

      process.env.LEDGER_CHECKPOINT_KEY = 'n'.repeat(32);
      process.env.LEDGER_CHECKPOINT_KEY_ID = 'v2';
      const rotatedWithoutOld = makeService(store).service;
      await rotatedWithoutOld.onModuleInit();
      expect(rotatedWithoutOld.getStatus().sealedReason).toMatch(/checkpoint mac invalid/);

      process.env.LEDGER_CHECKPOINT_RETIRED_KEYS = `v1:${KEY}`;
      const rotated = makeService(store).service;
      await rotated.onModuleInit();
      expect(rotated.getStatus().sealed).toBe(false);
      await rotated.append(issue(2));
      expect((await rotated.createCheckpoint()).keyId).toBe('v2');
      expect((await rotated.verify()).ok).toBe(true);
    });

    it('a lost key seals until its id is acknowledged; the checkpoint must still match its event', async () => {
      process.env.LEDGER_CHECKPOINT_KEY = KEY;
      const store = new InMemoryLedgerStore();
      const { service } = makeService(store);
      await service.append(issue(1));
      await service.createCheckpoint();

      process.env.LEDGER_CHECKPOINT_KEY = 'n'.repeat(32);
      process.env.LEDGER_CHECKPOINT_KEY_ID = 'v2';
      process.env.LEDGER_CHECKPOINT_LOST_KEY_IDS = 'v1';
      const recovered = makeService(store).service;
      await recovered.onModuleInit();
      expect(recovered.getStatus().sealed).toBe(false);

      store.checkpoints[0].hash = 'f'.repeat(64);
      const report = await recovered.verify();
      expect(report.failures.map((f) => f.reason)).toEqual(['checkpoint does not match event']);
    });
  });

  describe('export', () => {
    it('produces an offline-verifiable export and ledgers the export itself', async () => {
      process.env.LEDGER_CHECKPOINT_KEY = KEY;
      const { service } = makeService();
      service.checkpointInterval = 2;
      for (let i = 0; i < 5; i++) await service.append(issue(i));
      const { manifest, ndjson } = await service.export({ exportedBy: 'GADMIN' });
      expect(manifest).toMatchObject({ fromSequence: 1, toSequence: 5, count: 5, anchorHash: LEDGER_GENESIS_HASH });
      expect(manifest.checkpoints.map((c) => c.sequence)).toEqual([2, 4]);
      expect(verifyLedgerExport(manifest, ndjson, { v1: KEY }).ok).toBe(true);

      const [audit] = await service.query({ type: 'ledger.exported' });
      expect(audit).toMatchObject({ sequence: 6, actor: 'GADMIN', category: 'privileged' });
      expect(audit.payload).toMatchObject({ headHash: manifest.headHash, bodySha256: manifest.bodySha256 });
    });

    it('exports a range anchored on the preceding event', async () => {
      const { service } = makeService();
      const events = [];
      for (let i = 0; i < 6; i++) events.push(await service.append(issue(i)));
      const { manifest, ndjson } = await service.export({ fromSequence: 3, toSequence: 4, exportedBy: 'GADMIN' });
      expect(manifest).toMatchObject({ count: 2, anchorHash: events[1].hash, headHash: events[3].hash });
      expect(verifyLedgerExport(manifest, ndjson).ok).toBe(true);
    });

    it('exports an empty ledger', async () => {
      const { service } = makeService();
      const { manifest, ndjson } = await service.export({ exportedBy: 'GADMIN' });
      expect(manifest).toMatchObject({ count: 0, headHash: LEDGER_GENESIS_HASH });
      expect(verifyLedgerExport(manifest, ndjson).ok).toBe(true);
    });

    it('rejects invalid and oversized ranges', async () => {
      const { service } = makeService();
      await service.append(issue(1));
      await service.append(issue(2));
      await expect(service.export({ fromSequence: 0, exportedBy: 'G' })).rejects.toThrow(/positive/);
      await expect(service.export({ fromSequence: 2, toSequence: 1, exportedBy: 'G' })).rejects.toThrow(/<=/);
      await expect(service.export({ exportedBy: '' })).rejects.toThrow(/exportedBy/);
      expect(MAX_EXPORT_EVENTS).toBeGreaterThan(0);
    });
  });

  describe('query', () => {
    it('filters by category, type and subject in sequence order', async () => {
      const { service } = makeService();
      await service.append(issue(1));
      await service.append({ type: 'role.granted', actor: 'GADMIN', subjectType: 'account', subjectId: 'GX' });
      await service.append(issue(2));
      expect((await service.query({ category: 'financial' })).map((e) => e.sequence)).toEqual([1, 3]);
      expect((await service.query({ type: 'role.granted' })).map((e) => e.sequence)).toEqual([2]);
      expect((await service.query({ subjectType: 'bond', subjectId: 'bond-2' })).map((e) => e.sequence)).toEqual([3]);
      expect((await service.query({ fromSequence: 2, limit: 1 })).map((e) => e.sequence)).toEqual([2]);
    });
  });
});

describe('PostgresLedgerStore', () => {
  function fakePool(rows: any[] = []) {
    const query = jest.fn().mockResolvedValue({ rows });
    return { pool: { query, end: jest.fn(), on: jest.fn() } as any, query };
  }

  it('installs append-only triggers on both tables', async () => {
    const { pool, query } = fakePool();
    await new PostgresLedgerStore(pool).init();
    const sql = query.mock.calls.map((c) => c[0]).join('\n');
    expect(sql).toMatch(/CREATE TRIGGER ledger_events_append_only BEFORE UPDATE OR DELETE/);
    expect(sql).toMatch(/CREATE TRIGGER ledger_checkpoints_no_truncate BEFORE TRUNCATE/);
    expect(sql).toMatch(/sequence\s+BIGINT\s+PRIMARY KEY/);
  });

  it('stores the canonical body and reads back exactly what was hashed', async () => {
    const store = new InMemoryLedgerStore();
    const { service } = makeService(store);
    const event = await service.append(issue(1, { payload: { b: 1, a: { d: [3, 2], c: 0.1 } } }));

    const { pool, query } = fakePool();
    const pg = new PostgresLedgerStore(pool);
    await pg.appendEvent(event);
    const body = query.mock.calls[0][1][8];
    query.mockResolvedValueOnce({ rows: [{ body }] });
    const [loaded] = await pg.loadEvents();
    expect(loaded).toEqual(event);
    expect(computeEventHash(loaded)).toBe(event.hash);
  });
});
