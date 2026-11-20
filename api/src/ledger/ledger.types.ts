/**
 * Types for the tamper-evident chronological event ledger.
 *
 * Unlike the per-entity audit chain (`api/src/audit`), the ledger is ONE global
 * chain: every privileged or financial event across the protocol gets the
 * next sequence number, so the ledger also proves the relative order of events
 * on different entities (e.g. "the KYC override happened before the coupon
 * distribution"). See `docs/event-ledger.md`.
 */

/** Bump only together with a hashing change and a documented migration. */
export const LEDGER_SCHEMA_VERSION = 1;

/** `previousHash` of sequence 1. 64 hex zeros, the width of a SHA-256 digest. */
export const LEDGER_GENESIS_HASH = '0'.repeat(64);

export type LedgerCategory = 'privileged' | 'financial';

/**
 * Closed registry of event types. Each type is bound to exactly one category
 * so a financial event cannot be filed (and later filtered away) as
 * privileged, and a typo'd type cannot create a new, unmonitored stream.
 * Adding a type is a code change and therefore reviewed.
 */
export const LEDGER_EVENT_TYPES = {
  // Privileged: actions only an admin, maintainer, or operator can take.
  'role.granted': 'privileged',
  'role.revoked': 'privileged',
  'admin.intent.executed': 'privileged',
  'impersonation.started': 'privileged',
  'impersonation.operation_allowed': 'privileged',
  'impersonation.operation_denied': 'privileged',
  'impersonation.ended': 'privileged',
  'impersonation.expired': 'privileged',
  'impersonation.revoked': 'privileged',
  'kyc.override': 'privileged',
  'oracle.override': 'privileged',
  'config.changed': 'privileged',
  'ledger.exported': 'privileged',

  // Financial: anything that moves, creates, or destroys value.
  'bond.issued': 'financial',
  'subscription.allocated': 'financial',
  'coupon.distributed': 'financial',
  'carbon_credit.retired': 'financial',
  'settlement.completed': 'financial',
  'settlement.rolled_back': 'financial',
  'redemption.processed': 'financial',
  'fee.collected': 'financial',
} as const satisfies Record<string, LedgerCategory>;

export type LedgerEventType = keyof typeof LEDGER_EVENT_TYPES;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface LedgerEventInput {
  type: LedgerEventType;
  /** Principal that caused the event (wallet address, `system:<job>`, ...). */
  actor: string;
  subjectType: string;
  subjectId: string;
  /** Plain JSON only; validated by `assertLedgerPayload`. */
  payload?: Record<string, JsonValue>;
  /** Request correlation id (#398), when the event came from a request. */
  correlationId?: string;
  /** Business time, if it differs from when the ledger recorded the event. */
  occurredAt?: string;
}

export interface LedgerEvent {
  schemaVersion: number;
  sequence: number;
  eventId: string;
  category: LedgerCategory;
  type: LedgerEventType;
  actor: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, JsonValue>;
  correlationId: string | null;
  occurredAt: string;
  /** Ledger time; never decreases along the chain. */
  recordedAt: string;
  previousHash: string;
  hash: string;
}

/**
 * Keyed attestation of the chain head at one sequence. Recomputing every hash
 * after an edit yields a self-consistent chain, so hashes alone cannot detect
 * a full rewrite by someone with write access to storage; a checkpoint MAC
 * made with a key that storage never sees can.
 */
export interface LedgerCheckpoint {
  sequence: number;
  hash: string;
  recordedAt: string;
  createdAt: string;
  keyId: string;
  mac: string;
}

export type LedgerFailureReason =
  | 'unsupported schema version'
  | 'sequence break'
  | 'previous hash mismatch'
  | 'content hash mismatch'
  | 'recordedAt went backwards'
  | 'unknown event type'
  | 'category mismatch'
  | 'duplicate event id'
  | 'checkpoint mac invalid'
  | 'checkpoint does not match event'
  | 'checkpoint beyond ledger head'
  | 'head mismatch'
  | 'export body digest mismatch'
  | 'export manifest mismatch'
  | 'malformed event';

export interface LedgerVerificationFailure {
  /** Sequence the failure is anchored to (null when not event-specific). */
  sequence: number | null;
  reason: LedgerFailureReason;
  expected: string | null;
  actual: string | null;
}

export interface LedgerVerificationReport {
  ok: boolean;
  checkedEvents: number;
  checkedCheckpoints: number;
  firstSequence: number | null;
  lastSequence: number | null;
  headHash: string;
  failures: LedgerVerificationFailure[];
}

export interface LedgerExportManifest {
  format: 'verdant-ledger-ndjson';
  schemaVersion: number;
  fromSequence: number;
  toSequence: number;
  count: number;
  /** `previousHash` of the first exported event (genesis for a full export). */
  anchorHash: string;
  headHash: string;
  exportedAt: string;
  exportedBy: string;
  /** SHA-256 of the exact NDJSON body bytes. */
  bodySha256: string;
  checkpoints: LedgerCheckpoint[];
}

export interface LedgerExport {
  manifest: LedgerExportManifest;
  /** One canonical JSON event per line, `\n`-terminated. */
  ndjson: string;
}
