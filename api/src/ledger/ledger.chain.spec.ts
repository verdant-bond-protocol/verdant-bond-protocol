import {
  assertLedgerPayload,
  computeCheckpointMac,
  computeEventHash,
  serializeNdjson,
  sha256Hex,
  verifyLedgerEvents,
  verifyLedgerExport,
} from './ledger.chain';
import {
  LEDGER_GENESIS_HASH,
  LEDGER_SCHEMA_VERSION,
  LedgerCheckpoint,
  LedgerEvent,
  LedgerEventType,
  LedgerExportManifest,
} from './ledger.types';
import { LEDGER_EVENT_TYPES } from './ledger.types';

const KEY = 'k'.repeat(32);
const KEYS = { v1: KEY };

/** Build a valid chain of `n` events without the service. */
function buildChain(n: number, start = 1, anchor = LEDGER_GENESIS_HASH): LedgerEvent[] {
  const types: LedgerEventType[] = ['bond.issued', 'kyc.override', 'coupon.distributed', 'settlement.completed'];
  const events: LedgerEvent[] = [];
  let previousHash = anchor;
  for (let i = 0; i < n; i++) {
    const type = types[i % types.length];
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, start + i)).toISOString();
    const unhashed = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      sequence: start + i,
      eventId: `evt-${start + i}`,
      category: LEDGER_EVENT_TYPES[type],
      type,
      actor: 'GADMIN',
      subjectType: 'bond',
      subjectId: `bond-${i % 2}`,
      payload: { amount: String(1000 + i), nested: { tranche: 'A', legs: [1, 2] } },
      correlationId: null,
      occurredAt: at,
      recordedAt: at,
      previousHash,
    };
    const event = { ...unhashed, hash: computeEventHash(unhashed) };
    events.push(event);
    previousHash = event.hash;
  }
  return events;
}

/** Recompute every hash from `from` on, as an attacker with storage access would. */
function rehash(events: LedgerEvent[], from = 0): LedgerEvent[] {
  let previousHash = from === 0 ? LEDGER_GENESIS_HASH : events[from - 1].hash;
  return events.map((e, i) => {
    if (i < from) return e;
    const next = { ...e, previousHash };
    next.hash = computeEventHash(next);
    previousHash = next.hash;
    return next;
  });
}

function checkpointAt(event: LedgerEvent, key = KEY, keyId = 'v1'): LedgerCheckpoint {
  const base = { sequence: event.sequence, hash: event.hash, recordedAt: event.recordedAt, createdAt: event.recordedAt, keyId };
  return { ...base, mac: computeCheckpointMac(base, key) };
}

const reasons = (events: LedgerEvent[], opts = {}) => verifyLedgerEvents(events, opts).failures.map((f) => f.reason);

describe('ledger chain verification', () => {
  it('accepts an untouched chain and reports its head', () => {
    const chain = buildChain(6);
    const report = verifyLedgerEvents(chain);
    expect(report.ok).toBe(true);
    expect(report.checkedEvents).toBe(6);
    expect(report.lastSequence).toBe(6);
    expect(report.headHash).toBe(chain[5].hash);
  });

  it('accepts an empty ledger whose head is genesis', () => {
    const report = verifyLedgerEvents([]);
    expect(report.ok).toBe(true);
    expect(report.headHash).toBe(LEDGER_GENESIS_HASH);
  });

  it('hash is independent of payload key order', () => {
    const [e] = buildChain(1);
    const reordered = { ...e, payload: { nested: { legs: [1, 2], tranche: 'A' }, amount: e.payload.amount } };
    expect(computeEventHash(reordered)).toBe(e.hash);
  });

  describe('tamper detection', () => {
    it.each([
      ['payload amount', (e: LedgerEvent) => ({ ...e, payload: { ...e.payload, amount: '999999' } })],
      ['nested payload', (e: LedgerEvent) => ({ ...e, payload: { ...e.payload, nested: { tranche: 'B', legs: [1, 2] } } })],
      ['actor', (e: LedgerEvent) => ({ ...e, actor: 'GATTACKER' })],
      ['subject', (e: LedgerEvent) => ({ ...e, subjectId: 'bond-9' })],
      ['recordedAt', (e: LedgerEvent) => ({ ...e, recordedAt: '2026-01-01T00:00:03.500Z' })],
      ['occurredAt', (e: LedgerEvent) => ({ ...e, occurredAt: '2025-01-01T00:00:00.000Z' })],
      ['correlationId', (e: LedgerEvent) => ({ ...e, correlationId: 'forged' })],
      ['eventId', (e: LedgerEvent) => ({ ...e, eventId: 'evt-x' })],
    ])('detects an altered %s', (_label, mutate) => {
      const chain = buildChain(5);
      chain[2] = mutate(chain[2]);
      const report = verifyLedgerEvents(chain);
      expect(report.ok).toBe(false);
      expect(report.failures[0]).toMatchObject({ sequence: 3, reason: 'content hash mismatch' });
    });

    it('detects a dropped event', () => {
      const chain = buildChain(5);
      chain.splice(2, 1);
      expect(reasons(chain)).toEqual(expect.arrayContaining(['sequence break', 'previous hash mismatch']));
    });

    it('detects reordered events', () => {
      const chain = buildChain(5);
      [chain[1], chain[2]] = [chain[2], chain[1]];
      expect(reasons(chain)).toEqual(expect.arrayContaining(['sequence break', 'previous hash mismatch']));
    });

    it('detects a forged event inserted mid-chain, even with a correct own hash', () => {
      const chain = buildChain(4);
      const forged = { ...chain[1], eventId: 'forged', sequence: 3, previousHash: chain[1].hash, payload: { amount: '1' } };
      forged.hash = computeEventHash(forged);
      chain.splice(2, 0, forged);
      const report = verifyLedgerEvents(chain);
      expect(report.ok).toBe(false);
      expect(report.failures.map((f) => f.reason)).toContain('sequence break');
    });

    it('detects a duplicated (replayed) event', () => {
      const chain = buildChain(3);
      chain.push(chain[2]);
      expect(reasons(chain)).toEqual(expect.arrayContaining(['duplicate event id', 'sequence break']));
    });

    it('detects a recategorised event even when its hash was recomputed', () => {
      const chain = buildChain(3);
      chain[0] = { ...chain[0], category: 'privileged' };
      expect(reasons(rehash(chain))).toEqual(['category mismatch']);
    });

    it('detects an unregistered event type', () => {
      const chain = buildChain(2);
      chain[1] = { ...chain[1], type: 'bond.vanished' as LedgerEventType };
      expect(reasons(rehash(chain))).toEqual(['unknown event type']);
    });

    it('detects ledger time going backwards', () => {
      const chain = buildChain(3);
      chain[2] = { ...chain[2], recordedAt: '2025-12-31T00:00:00.000Z' };
      expect(reasons(rehash(chain))).toEqual(['recordedAt went backwards']);
    });

    it('detects an unsupported schema version', () => {
      const chain = buildChain(2);
      chain[1] = { ...chain[1], schemaVersion: 99 };
      expect(reasons(rehash(chain))).toEqual(['unsupported schema version']);
    });

    it('reports a malformed row instead of throwing', () => {
      const chain: any[] = buildChain(2);
      chain.push({ sequence: 3, nonsense: true });
      expect(reasons(chain)).toContain('malformed event');
    });

    it('a full rewrite with recomputed hashes passes plain verification...', () => {
      const chain = buildChain(5);
      chain[1] = { ...chain[1], payload: { amount: '1' } };
      expect(verifyLedgerEvents(rehash(chain, 1)).ok).toBe(true);
    });

    it('...but is caught by a keyed checkpoint taken before the rewrite', () => {
      const original = buildChain(5);
      const checkpoints = [checkpointAt(original[4])];
      const tampered = [...original];
      tampered[1] = { ...tampered[1], payload: { amount: '1' } };
      const report = verifyLedgerEvents(rehash(tampered, 1), { checkpoints, checkpointKeys: KEYS });
      expect(report.failures.map((f) => f.reason)).toEqual(['checkpoint does not match event']);
    });

    it('rejects a checkpoint the attacker forged without the key', () => {
      const chain = rehash(buildChain(5).map((e, i) => (i === 1 ? { ...e, payload: { amount: '1' } } : e)), 1);
      const forged = checkpointAt(chain[4], 'x'.repeat(32));
      expect(reasons(chain, { checkpoints: [forged], checkpointKeys: KEYS })).toEqual(['checkpoint mac invalid']);
    });

    it('rejects a checkpoint signed under an unknown key id', () => {
      const chain = buildChain(3);
      expect(reasons(chain, { checkpoints: [checkpointAt(chain[2], KEY, 'v9')], checkpointKeys: KEYS })).toEqual([
        'checkpoint mac invalid',
      ]);
    });

    it('accepts checkpoints made under a retired key', () => {
      const chain = buildChain(3);
      const old = 'o'.repeat(32);
      const report = verifyLedgerEvents(chain, {
        checkpoints: [checkpointAt(chain[0], old, 'v0'), checkpointAt(chain[2])],
        checkpointKeys: { v0: old, v1: KEY },
      });
      expect(report.ok).toBe(true);
      expect(report.checkedCheckpoints).toBe(2);
    });

    it('detects tail truncation via a checkpoint past the head', () => {
      const chain = buildChain(5);
      const checkpoints = [checkpointAt(chain[4])];
      expect(reasons(chain.slice(0, 3), { checkpoints, checkpointKeys: KEYS })).toEqual(['checkpoint beyond ledger head']);
    });

    it('detects tail truncation against a trusted head', () => {
      const chain = buildChain(5);
      const truncated = chain.slice(0, 4);
      expect(verifyLedgerEvents(truncated).ok).toBe(true); // chain alone cannot tell
      expect(reasons(truncated, { expectedHeadHash: chain[4].hash, expectedLastSequence: 5 })).toEqual([
        'head mismatch',
        'head mismatch',
      ]);
    });

    it('verifies a segment from its anchor, and rejects a wrong anchor', () => {
      const chain = buildChain(6);
      const segment = chain.slice(3);
      expect(verifyLedgerEvents(segment, { anchorHash: chain[2].hash, startSequence: 4 }).ok).toBe(true);
      expect(reasons(segment, { anchorHash: chain[1].hash, startSequence: 4 })).toEqual(['previous hash mismatch']);
    });
  });
});

describe('ledger export verification', () => {
  function makeExport(events: LedgerEvent[], checkpoints: LedgerCheckpoint[] = []) {
    const ndjson = serializeNdjson(events);
    const manifest: LedgerExportManifest = {
      format: 'verdant-ledger-ndjson',
      schemaVersion: LEDGER_SCHEMA_VERSION,
      fromSequence: events[0].sequence,
      toSequence: events[events.length - 1].sequence,
      count: events.length,
      anchorHash: events[0].previousHash,
      headHash: events[events.length - 1].hash,
      exportedAt: '2026-02-01T00:00:00.000Z',
      exportedBy: 'GADMIN',
      bodySha256: sha256Hex(ndjson),
      checkpoints,
    };
    return { manifest, ndjson };
  }

  it('round-trips a full export', () => {
    const chain = buildChain(4);
    const { manifest, ndjson } = makeExport(chain, [checkpointAt(chain[3])]);
    expect(verifyLedgerExport(manifest, ndjson, KEYS).ok).toBe(true);
  });

  it('round-trips a partial export', () => {
    const chain = buildChain(8);
    const { manifest, ndjson } = makeExport(chain.slice(4));
    expect(verifyLedgerExport(manifest, ndjson).ok).toBe(true);
  });

  it('detects an edited line in the body', () => {
    const { manifest, ndjson } = makeExport(buildChain(3));
    const edited = ndjson.replace('"amount":"1001"', '"amount":"9001"');
    const failures = verifyLedgerExport(manifest, edited).failures.map((f) => f.reason);
    expect(failures).toEqual(expect.arrayContaining(['content hash mismatch', 'export body digest mismatch']));
  });

  it('detects a dropped last line (truncated export)', () => {
    const { manifest, ndjson } = makeExport(buildChain(3));
    const truncated = ndjson.split('\n').slice(0, 2).join('\n') + '\n';
    const failures = verifyLedgerExport(manifest, truncated).failures.map((f) => f.reason);
    expect(failures).toEqual(expect.arrayContaining(['head mismatch', 'export body digest mismatch', 'export manifest mismatch']));
  });

  it('detects a manifest whose head was swapped', () => {
    const chain = buildChain(3);
    const { manifest, ndjson } = makeExport(chain);
    expect(verifyLedgerExport({ ...manifest, headHash: chain[1].hash }, ndjson).failures.map((f) => f.reason)).toEqual([
      'head mismatch',
    ]);
  });

  it('reports non-JSON lines without throwing', () => {
    const { manifest } = makeExport(buildChain(1));
    expect(verifyLedgerExport(manifest, '{not json}\n').failures[0].reason).toBe('malformed event');
  });
});

describe('assertLedgerPayload', () => {
  it('accepts plain JSON', () => {
    expect(() => assertLedgerPayload({ a: 1, b: ['x', null, { c: true }] })).not.toThrow();
  });

  it.each([
    ['a Date', { at: new Date() }],
    ['NaN', { n: NaN }],
    ['Infinity', { n: Infinity }],
    ['undefined', { u: undefined }],
    ['a function', { f: () => 1 }],
    ['a bigint', { b: BigInt(1) }],
    ['a class instance', { m: new Map() }],
    ['a secret key', { privateKey: 'S...' }],
    ['a nested token', { auth: { access_token: 'x' } }],
  ])('rejects %s', (_label, payload) => {
    expect(() => assertLedgerPayload(payload)).toThrow();
  });

  it('allows financial fields that merely contain sensitive words', () => {
    expect(() => assertLedgerPayload({ tokenAmount: '10', seedRound: 'A', tokenId: 'BOND' })).not.toThrow();
  });

  it('rejects oversized payloads', () => {
    expect(() => assertLedgerPayload({ blob: 'x'.repeat(17 * 1024) })).toThrow(/limit/);
  });
});
