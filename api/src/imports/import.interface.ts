/**
 * Secure import pipeline types (see docs/import-pipeline.md).
 *
 * An import is a two-phase operation: a side-effect-free PREVIEW that
 * classifies every row as accepted or quarantined, then a COMMIT that applies
 * only the accepted rows the operator reviewed. Every applied row leaves a
 * trace entry carrying its before/after state, which is what makes retry and
 * rollback safe.
 */

export type ImportKind = 'kyc_attestation';

export type ImportFormat = 'json' | 'csv';

/** A raw input row: flat key → scalar map, exactly as parsed. */
export type RawImportRow = Record<string, unknown>;

/** A row after schema validation, keyed by the sink's field names. */
export type NormalizedImportRow = Record<string, string | number | null>;

export enum QuarantineCode {
  /** Key such as `__proto__` / `constructor` that could pollute prototypes. */
  FORBIDDEN_KEY = 'FORBIDDEN_KEY',
  /** Column not in the sink's schema (strict schemas catch column shifts). */
  UNKNOWN_FIELD = 'UNKNOWN_FIELD',
  /** Value is an object/array/boolean where a scalar was expected. */
  INVALID_TYPE = 'INVALID_TYPE',
  /** Cell starts with = + - @ TAB CR: spreadsheet formula injection. */
  FORMULA_INJECTION = 'FORMULA_INJECTION',
  /** Control, zero-width or bidi-override characters. */
  UNSAFE_CHARACTERS = 'UNSAFE_CHARACTERS',
  FIELD_TOO_LONG = 'FIELD_TOO_LONG',
  MISSING_FIELD = 'MISSING_FIELD',
  INVALID_VALUE = 'INVALID_VALUE',
  INVALID_ADDRESS = 'INVALID_ADDRESS',
  /** The same natural key appears more than once in one batch. */
  DUPLICATE_IN_BATCH = 'DUPLICATE_IN_BATCH',
  /** Row is valid but crosses a policy line that needs a human decision. */
  REQUIRES_REVIEW = 'REQUIRES_REVIEW',
  /** Target record changed between preview and commit; not overwritten. */
  STATE_DRIFT = 'STATE_DRIFT',
  /** Row failed to apply MAX_ROW_ATTEMPTS times; skipped on retry. */
  APPLY_FAILED = 'APPLY_FAILED',
  /** CSV line could not be parsed (unbalanced quotes, column count). */
  MALFORMED_ROW = 'MALFORMED_ROW',
}

export interface QuarantineReason {
  code: QuarantineCode;
  field?: string;
  /** Operator-facing. Never echoes the offending value. */
  message: string;
}

export type RowVerdict = 'accepted' | 'quarantined';

/** What committing the row would do to the target record. */
export type RowAction = 'create' | 'update' | 'noop';

export interface PreviewRow {
  index: number;
  /** 1-based source line (CSV) or array position + 1 (JSON). */
  line: number;
  /** sha256 of the canonical normalized row (raw row if it never normalized). */
  fingerprint: string;
  verdict: RowVerdict;
  reasons: QuarantineReason[];
  /** Natural key in the target store (e.g. the Stellar address). */
  key: string | null;
  action: RowAction | null;
  normalized: NormalizedImportRow | null;
  /** Target state observed at preview; commit refuses if it changed. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Raw input, kept for quarantined rows only so operators can fix them. */
  raw?: RawImportRow;
}

export type ImportBatchStatus =
  | 'previewed'
  | 'committing'
  | 'committed'
  | 'partially_committed'
  | 'rolling_back'
  | 'rolled_back'
  | 'rollback_incomplete'
  | 'discarded'
  | 'expired';

export interface ImportTraceEntry {
  batchId: string;
  rowIndex: number;
  line: number;
  fingerprint: string;
  key: string;
  action: RowAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  appliedAt: string;
  actor: string;
  rolledBackAt?: string;
}

export interface RollbackConflict {
  /**
   * conflict: record changed after import, left untouched (blocks).
   * error:    revert threw; re-running rollback retries it (blocks).
   * residual: reverted, but the store could not restore every field exactly
   *           (e.g. the KYC store cannot clear an expiry); informational.
   */
  kind: 'conflict' | 'error' | 'residual';
  rowIndex: number;
  key: string;
  message: string;
}

export interface ImportBatchSummary {
  total: number;
  accepted: number;
  quarantined: number;
  create: number;
  update: number;
  noop: number;
  applied: number;
  rolledBack: number;
}

export interface ImportBatch {
  id: string;
  kind: ImportKind;
  status: ImportBatchStatus;
  actor: string;
  sourceName: string | null;
  format: ImportFormat;
  /** sha256 of the exact submitted payload. */
  sourceSha256: string;
  /**
   * Binds a commit to what was reviewed: sha256 over kind + every row's
   * fingerprint, verdict and action. The commit request must echo it.
   */
  previewHash: string;
  /** Earlier batch with the same content that was committed, if any. */
  duplicateOf: string | null;
  createdAt: string;
  previewExpiresAt: string;
  updatedAt: string;
  rows: PreviewRow[];
  trace: ImportTraceEntry[];
  /** rowIndex → failed apply attempts, for retry bookkeeping. */
  attempts: Record<number, number>;
  lastError: { rowIndex: number; message: string; at: string } | null;
  rollbackConflicts: RollbackConflict[];
  summary: ImportBatchSummary;
}

/** Result of asking a sink what a row would do, with no side effects. */
export interface SinkInspection {
  key: string;
  action: RowAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  /** Policy verdicts that need a human (e.g. un-rejecting a KYC record). */
  reviewReasons: QuarantineReason[];
}

/**
 * A destination for one import kind. Implementations own the schema, the
 * natural key and how to apply and undo a row. `inspect` MUST be free of side
 * effects: preview is allowed to run against production state.
 */
export interface ImportSink {
  readonly kind: ImportKind;
  /** Exact set of accepted columns; anything else is UNKNOWN_FIELD. */
  readonly fields: readonly string[];
  normalize(row: RawImportRow): { row: NormalizedImportRow | null; reasons: QuarantineReason[] };
  keyOf(row: NormalizedImportRow): string;
  inspect(row: NormalizedImportRow): Promise<SinkInspection>;
  apply(row: NormalizedImportRow, ctx: { batchId: string; rowIndex: number; fingerprint: string; actor: string }): Promise<Record<string, unknown>>;
  /** Current state of `key`, in the same shape as `before`/`after`. */
  current(key: string): Promise<Record<string, unknown> | null>;
  /** Restore `entry.before`. Called only after `current` matched `entry.after`. */
  revert(entry: ImportTraceEntry, ctx: { actor: string }): Promise<void>;
}
