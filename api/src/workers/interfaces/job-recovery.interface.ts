import { JobStatus, JobType } from './job.interface';

/**
 * Recovery metadata attached to a job record. Every field is optional so a job
 * written by an older worker (pre-recovery) is still valid — see the migration
 * notes in docs/RESUMABLE_JOBS_RECOVERY.md.
 */
export enum RecoverySource {
  DEAD_LETTER = 'dead_letter',
  STUCK = 'stuck',
}

export interface JobRecoveryAuditEntry {
  /** Unique id (uuid) so concurrent recoveries cannot collapse into one entry. */
  id: string;
  jobId: string;
  jobType: JobType;
  source: RecoverySource;
  fromStatus: JobStatus;
  toStatus: JobStatus;
  retriesBefore: number;
  retriesAfter: number;
  /** Wallet/id of the operator that triggered the recovery, when available. */
  actor?: string;
  correlationId: string;
  recoveredAt: string;
}

export interface RecoverDeadLetterOptions {
  /** Reset the retry counter to zero (default true). */
  resetRetries?: boolean;
  /** Override the retry budget when re-queuing (must be >= current retries). */
  maxRetries?: number;
  /** Operator identity recorded in the audit trail. */
  actor?: string;
}

export interface RecoverStuckOptions {
  /**
   * Only jobs whose `startedAt` is at least this old are considered stuck.
   * Defaults to JOB_PROCESSING_TIMEOUT_MS so a live job is never recovered.
   */
  olderThanMs?: number;
  limit?: number;
  actor?: string;
  /** Deterministic clock for tests; defaults to Date.now(). */
  now?: number;
}

export interface StuckRecoveryResult {
  recovered: string[];
  examined: number;
  /** Jobs that were skipped because their processing lock is still live. */
  stillLocked: number;
}

/** Why a dependency fallback was chosen for a job/workflow. */
export type FallbackStrategy =
  | 'proceed'
  | 'fail_closed'
  | 'retry'
  | 'fallback'
  | 'degrade'
  | 'reject';

export interface FallbackDecision {
  dependency: string;
  state: string;
  strategy: FallbackStrategy;
  retryable: boolean;
  /** Effective retry budget for this dependency/state pair. */
  maxRetries: number;
  /** Base backoff in ms; callers apply their own jitter. */
  backoffMs: number;
  /** Human-safe explanation; never contains secrets. */
  message: string;
  /** Which fallback data source is used when strategy === 'fallback'. */
  fallbackSource?: string;
  /** Job types whose processing is affected by this dependency/state pair. */
  affectsJobTypes: JobType[];
}
