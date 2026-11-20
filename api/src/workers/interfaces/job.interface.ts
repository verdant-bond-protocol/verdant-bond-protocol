export enum JobType {
  RECONCILIATION = 'reconciliation',
  DATA_EXPORT = 'data_export',
  COUPON_DISTRIBUTION = 'coupon_distribution',
  ORACLE_SYNC = 'oracle_sync',
  PORTFOLIO_REBALANCE = 'portfolio_rebalance',
}

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SUCCESS = 'success',
  FAILED = 'failed',
  DEAD_LETTER = 'dead_letter',
}

export interface JobPayload {
  type: JobType;
  data: Record<string, any>;
  userId?: string;
  correlationId?: string;
  /** Optional replay-suppression key; see job-payload-validation.ts. */
  idempotencyKey?: string;
}

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  payload: JobPayload;
  retries: number;
  maxRetries: number;
  correlationId: string;
  lastError?: string;
  lastErrorAt?: Date;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: Record<string, any>;
  /** Caller whose per-user admission budget this job counts against (#391). */
  admittedFor?: string;

  // ── Optional recovery/idempotency metadata (additive, backward compatible) ──
  /** Stable key used to suppress replayed enqueue requests. */
  idempotencyKey?: string;
  /** Number of times this job has been recovered (dead-letter or stuck sweep). */
  recoveryAttempts?: number;
  /** ISO timestamp of the most recent recovery. */
  lastRecoveredAt?: Date;
  /** Where the most recent recovery originated. */
  recoveredFrom?: 'dead_letter' | 'stuck';
}

export const DEFAULT_MAX_RETRIES = 3;
export const JOB_PROCESSING_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Maximum accepted size of a job's `data` object, in bytes once serialized.
 * Bounds Redis memory and prevents a malformed/oversized payload from being
 * persisted and retried forever.
 */
export const MAX_JOB_DATA_BYTES = 64 * 1024;

/** Maximum length of an idempotency key or correlation id. */
export const MAX_JOB_KEY_LENGTH = 128;
