/**
 * Partial failure dashboard for background and external integrations
 * (issue #266).
 *
 * Tracks operations stuck between internal state and external systems (e.g.
 * a Soroban transaction submitted but not yet confirmed, an oracle report
 * ingested but not projected), grouped for maintainers by operation type,
 * age, severity and retryability — with enough metadata to investigate
 * without leaking secrets.
 */

export type PartialFailureStatus = 'open' | 'retrying' | 'resolved' | 'ignored';

export type PartialFailureSeverity = 'info' | 'warning' | 'critical';

export interface PartialFailure {
  id: string;
  /** Operation kind, e.g. `stellar.settlement`, `oracle.ingestion`. */
  operationType: string;
  /** Reference in the EXTERNAL system (opaque id, tx hash, cursor…). */
  externalRef?: string;
  message: string;
  severity: PartialFailureSeverity;
  retryable: boolean;
  status: PartialFailureStatus;
  createdAt: string;
  lastFailureAt: string;
  /** How many times a retry link/action has been used. */
  retryCount: number;
  /** Secret-free context for investigation. */
  metadata: Record<string, unknown>;
  resolvedAt?: string;
  ignoredAt?: string;
  resolvedNote?: string;
  ignoredNote?: string;
}

export interface PartialFailureInput {
  operationType: string;
  externalRef?: string;
  message: string;
  severity?: PartialFailureSeverity;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface PartialFailureLinks {
  retry?: string;
  inspect: string;
  remediationDoc: string;
}

/** One grouped row of the maintainer dashboard. */
export interface PartialFailureGroup {
  operationType: string;
  total: number;
  byStatus: Record<PartialFailureStatus, number>;
  bySeverity: Record<PartialFailureSeverity, number>;
  retryable: number;
  oldestAgeMs: number | null;
  failures: Array<PartialFailure & { ageMs: number; stale: boolean; links: PartialFailureLinks }>;
}

export interface PartialFailureDashboard {
  generatedAt: string;
  unresolved: number;
  staleAfterMs: number;
  groups: PartialFailureGroup[];
}

export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
