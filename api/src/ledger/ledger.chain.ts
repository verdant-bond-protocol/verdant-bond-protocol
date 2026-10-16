import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { stableStringify } from '../audit/audit.canonical';
import {
  JsonValue,
  LEDGER_EVENT_TYPES,
  LEDGER_GENESIS_HASH,
  LEDGER_SCHEMA_VERSION,
  LedgerCheckpoint,
  LedgerEvent,
  LedgerExportManifest,
  LedgerFailureReason,
  LedgerVerificationReport,
} from './ledger.types';

/**
 * Pure hashing and verification for the event ledger. Nothing here touches
 * storage or Nest, so the same code verifies the live ledger, a Postgres dump,
 * and an offline export (`scripts/verify-ledger-export.ts`).
 */

/** Domain separation: a ledger hash can never collide with an audit hash. */
const EVENT_HASH_PREFIX = 'verdant-ledger:event:v1\n';
const CHECKPOINT_MAC_PREFIX = 'verdant-ledger:checkpoint:v1\n';

export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MIN_CHECKPOINT_KEY_LENGTH = 32;

/**
 * Keys that must never land in an append-only, exportable ledger: once
 * written they cannot be redacted without breaking the chain.
 */
const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'secret', 'clientsecret', 'token', 'accesstoken', 'refreshtoken', 'jwt',
  'privatekey', 'secretkey', 'seed', 'seedphrase', 'mnemonic', 'apikey', 'ssn',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.replace(/[_-]/g, '').toLowerCase());
}

export function computeEventHash(event: Omit<LedgerEvent, 'hash'> | LedgerEvent): string {
  return createHash('sha256')
    .update(
      EVENT_HASH_PREFIX +
        stableStringify({
          schemaVersion: event.schemaVersion,
          sequence: event.sequence,
          eventId: event.eventId,
          category: event.category,
          type: event.type,
          actor: event.actor,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          payload: event.payload,
          correlationId: event.correlationId,
          occurredAt: event.occurredAt,
          recordedAt: event.recordedAt,
          previousHash: event.previousHash,
        }),
    )
    .digest('hex');
}

export function computeCheckpointMac(
  checkpoint: Pick<LedgerCheckpoint, 'sequence' | 'hash' | 'recordedAt' | 'createdAt' | 'keyId'>,
  key: string,
): string {
  return createHmac('sha256', key)
    .update(
      CHECKPOINT_MAC_PREFIX +
        stableStringify({
          sequence: checkpoint.sequence,
          hash: checkpoint.hash,
          recordedAt: checkpoint.recordedAt,
          createdAt: checkpoint.createdAt,
          keyId: checkpoint.keyId,
        }),
    )
    .digest('hex');
}

/**
 * Reject anything `stableStringify` would silently change: a `Date` or class
 * instance serialises as `{}`, `NaN` as `null`, `undefined` disappears. Any of
 * those would make the stored payload differ from what the caller meant.
 */
export function assertLedgerPayload(payload: unknown): asserts payload is Record<string, JsonValue> {
  if (!isPlainObject(payload)) throw new Error('payload must be a plain JSON object');
  walk(payload, 'payload');
  const bytes = Buffer.byteLength(stableStringify(payload), 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload is ${bytes} bytes; limit is ${MAX_PAYLOAD_BYTES}`);
  }
}

function walk(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) throw new Error(`${path}.${key} looks like a secret and cannot be ledgered`);
      walk(child, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} is not JSON-safe (${value === undefined ? 'undefined' : typeof value})`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export interface VerifyOptions {
  /** `previousHash` expected on the first event. Defaults to genesis. */
  anchorHash?: string;
  /** Sequence expected on the first event. Defaults to 1. */
  startSequence?: number;
  checkpoints?: LedgerCheckpoint[];
  /**
   * Checkpoint keys by `keyId` (current and retired). Without it MACs are not
   * checked; with it, a checkpoint under an unknown key id fails.
   */
  checkpointKeys?: Record<string, string>;
  /**
   * Key ids an operator declared lost. Their MACs cannot be checked, but the
   * checkpoint must still match its event; anything else under an unknown id
   * fails.
   */
  lostKeyIds?: string[];
  /**
   * Head the verifier already trusts (from a checkpoint, an export manifest,
   * or an external anchor). The only way to detect a truncated tail: a chain
   * with its last N events removed is otherwise perfectly valid.
   */
  expectedHeadHash?: string;
  expectedLastSequence?: number;
}

/**
 * Walk the chain and report every inconsistency (not just the first), so an
 * operator sees the full extent of damage before choosing a recovery path.
 */
export function verifyLedgerEvents(
  events: LedgerEvent[],
  options: VerifyOptions = {},
): LedgerVerificationReport {
  const anchorHash = options.anchorHash ?? LEDGER_GENESIS_HASH;
  const startSequence = options.startSequence ?? 1;
  const report: LedgerVerificationReport = {
    ok: true,
    checkedEvents: events.length,
    checkedCheckpoints: 0,
    firstSequence: events.length ? events[0].sequence : null,
    lastSequence: events.length ? events[events.length - 1].sequence : null,
    headHash: events.length ? events[events.length - 1].hash : anchorHash,
    failures: [],
  };
  const fail = (sequence: number | null, reason: LedgerFailureReason, expected: unknown, actual: unknown) =>
    report.failures.push({
      sequence,
      reason,
      expected: expected === null || expected === undefined ? null : String(expected),
      actual: actual === null || actual === undefined ? null : String(actual),
    });

  const seenIds = new Set<string>();
  const bySequence = new Map<number, LedgerEvent>();
  let previousHash = anchorHash;
  let previousRecordedAt: string | null = null;
  let expectedSequence = startSequence;

  for (const event of events) {
    if (!isWellFormed(event)) {
      const raw = event as { sequence?: unknown } | null;
      fail(typeof raw?.sequence === 'number' ? raw.sequence : null, 'malformed event', 'ledger event', typeof raw);
      continue;
    }
    const seq = event.sequence;
    bySequence.set(seq, event);

    if (event.schemaVersion !== LEDGER_SCHEMA_VERSION) {
      fail(seq, 'unsupported schema version', LEDGER_SCHEMA_VERSION, event.schemaVersion);
    }
    if (seq !== expectedSequence) fail(seq, 'sequence break', expectedSequence, seq);
    if (event.previousHash !== previousHash) fail(seq, 'previous hash mismatch', previousHash, event.previousHash);

    const rebuilt = computeEventHash(event);
    if (rebuilt !== event.hash) fail(seq, 'content hash mismatch', rebuilt, event.hash);

    const registered = (LEDGER_EVENT_TYPES as Record<string, string>)[event.type];
    if (!registered) fail(seq, 'unknown event type', null, event.type);
    else if (registered !== event.category) fail(seq, 'category mismatch', registered, event.category);

    if (seenIds.has(event.eventId)) fail(seq, 'duplicate event id', null, event.eventId);
    seenIds.add(event.eventId);

    if (previousRecordedAt !== null && Date.parse(event.recordedAt) < Date.parse(previousRecordedAt)) {
      fail(seq, 'recordedAt went backwards', `>= ${previousRecordedAt}`, event.recordedAt);
    }

    // Continue from what the event claims so one bad link yields one failure
    // rather than cascading through every later event.
    previousHash = event.hash;
    previousRecordedAt = event.recordedAt;
    expectedSequence = seq + 1;
  }

  for (const checkpoint of options.checkpoints ?? []) {
    report.checkedCheckpoints++;
    if (options.checkpointKeys && !options.lostKeyIds?.includes(checkpoint.keyId)) {
      const key = options.checkpointKeys[checkpoint.keyId];
      if (!key || !macMatches(computeCheckpointMac(checkpoint, key), checkpoint.mac)) {
        fail(checkpoint.sequence, 'checkpoint mac invalid', key ? null : `known key id`, key ? checkpoint.mac : checkpoint.keyId);
        continue;
      }
    }
    const event = bySequence.get(checkpoint.sequence);
    if (!event) {
      // A checkpoint outside this segment is expected for partial exports;
      // past the head it means events were truncated.
      if (report.lastSequence === null || checkpoint.sequence > report.lastSequence) {
        fail(checkpoint.sequence, 'checkpoint beyond ledger head', checkpoint.sequence, report.lastSequence);
      }
      continue;
    }
    if (event.hash !== checkpoint.hash || event.recordedAt !== checkpoint.recordedAt) {
      fail(checkpoint.sequence, 'checkpoint does not match event', checkpoint.hash, event.hash);
    }
  }

  if (options.expectedHeadHash !== undefined && options.expectedHeadHash !== report.headHash) {
    fail(report.lastSequence, 'head mismatch', options.expectedHeadHash, report.headHash);
  }
  if (options.expectedLastSequence !== undefined && options.expectedLastSequence !== (report.lastSequence ?? 0)) {
    fail(report.lastSequence, 'head mismatch', options.expectedLastSequence, report.lastSequence ?? 0);
  }

  report.ok = report.failures.length === 0;
  return report;
}

function isWellFormed(event: any): event is LedgerEvent {
  return (
    !!event &&
    typeof event === 'object' &&
    Number.isInteger(event.sequence) &&
    typeof event.eventId === 'string' &&
    typeof event.hash === 'string' &&
    typeof event.previousHash === 'string' &&
    typeof event.recordedAt === 'string' &&
    typeof event.type === 'string' &&
    typeof event.category === 'string' &&
    event.payload !== null &&
    typeof event.payload === 'object'
  );
}

function macMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(actual ?? ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function serializeNdjson(events: LedgerEvent[]): string {
  return events.map((event) => stableStringify(event) + '\n').join('');
}

export function parseNdjson(body: string): LedgerEvent[] {
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`line ${i + 1} is not valid JSON`);
      }
    });
}

export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Verify an export without access to the live ledger: body digest, manifest
 * consistency, and the chain from `anchorHash` to `headHash`.
 */
export function verifyLedgerExport(
  manifest: LedgerExportManifest,
  ndjson: string,
  checkpointKeys?: Record<string, string>,
  lostKeyIds?: string[],
): LedgerVerificationReport {
  let events: LedgerEvent[];
  try {
    events = parseNdjson(ndjson);
  } catch (error) {
    return {
      ok: false,
      checkedEvents: 0,
      checkedCheckpoints: 0,
      firstSequence: null,
      lastSequence: null,
      headHash: manifest.anchorHash,
      failures: [{ sequence: null, reason: 'malformed event', expected: 'ndjson', actual: (error as Error).message }],
    };
  }

  const report = verifyLedgerEvents(events, {
    anchorHash: manifest.anchorHash,
    startSequence: manifest.fromSequence,
    checkpoints: manifest.checkpoints,
    checkpointKeys,
    lostKeyIds,
    expectedHeadHash: manifest.headHash,
    expectedLastSequence: manifest.count === 0 ? 0 : manifest.toSequence,
  });

  const digest = sha256Hex(ndjson);
  if (digest !== manifest.bodySha256) {
    report.failures.push({ sequence: null, reason: 'export body digest mismatch', expected: manifest.bodySha256, actual: digest });
  }
  if (events.length !== manifest.count) {
    report.failures.push({
      sequence: null,
      reason: 'export manifest mismatch',
      expected: `count ${manifest.count}`,
      actual: `count ${events.length}`,
    });
  }
  if (manifest.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    report.failures.push({
      sequence: null,
      reason: 'unsupported schema version',
      expected: String(LEDGER_SCHEMA_VERSION),
      actual: String(manifest.schemaVersion),
    });
  }
  report.ok = report.failures.length === 0;
  return report;
}
