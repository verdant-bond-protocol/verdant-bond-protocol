/**
 * Operator dashboard for unresolved partial failures (issue #535).
 *
 * A read-only projection over {@link PartialFailure} records that answers the
 * question an on-call operator actually has: "what is still broken, what do I
 * look at first, and what am I allowed to do about it?".
 *
 * Rules:
 * - Only live (non-archived), unresolved failures appear in the queue.
 * - Priority: critical before warning before info, then stale before fresh,
 *   then oldest first. Ordering is deterministic (ties broken by id).
 * - A retryable failure whose retry budget is exhausted is flagged
 *   `needsManualRemediation` and no longer offers a retry action, so the
 *   dashboard never invites an infinite retry loop.
 * - Actions are computed per row so the UI never offers an action the API
 *   would refuse (archived / resolved / non-retryable records).
 */

import { isArchived } from '../common/lifecycle/record-lifecycle';
import {
  DEFAULT_STALE_AFTER_MS,
  PartialFailure,
  PartialFailureSeverity,
} from './partial-failure.interface';

export const DEFAULT_MAX_RETRIES = 5;

export type OperatorAction = 'retry' | 'resolve' | 'archive' | 'inspect';

export interface OperatorQueueItem {
  id: string;
  operationType: string;
  externalRef?: string;
  severity: PartialFailureSeverity;
  status: PartialFailure['status'];
  ageMs: number;
  stale: boolean;
  retryCount: number;
  retriesRemaining: number;
  needsManualRemediation: boolean;
  actions: OperatorAction[];
}

export interface OperatorDashboard {
  generatedAt: string;
  totals: {
    unresolved: number;
    critical: number;
    stale: number;
    needsManualRemediation: number;
    retrying: number;
  };
  byOperationType: Record<string, number>;
  queue: OperatorQueueItem[];
}

export interface OperatorDashboardOptions {
  now?: number;
  staleAfterMs?: number;
  maxRetries?: number;
  /** Cap on queue rows returned; totals always reflect the full set. */
  limit?: number;
}

const SEVERITY_RANK: Record<PartialFailureSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function buildOperatorDashboard(
  failures: readonly PartialFailure[],
  opts: OperatorDashboardOptions = {},
): OperatorDashboard {
  const now = opts.now ?? Date.now();
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error('staleAfterMs must be a non-negative number');
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error('maxRetries must be a non-negative integer');
  }

  const totals = { unresolved: 0, critical: 0, stale: 0, needsManualRemediation: 0, retrying: 0 };
  const byOperationType: Record<string, number> = {};
  const queue: OperatorQueueItem[] = [];

  for (const failure of failures) {
    if (isArchived(failure) || failure.status === 'resolved') continue;

    const ageMs = Math.max(0, now - Date.parse(failure.createdAt));
    const stale = ageMs >= staleAfterMs;
    const retriesRemaining = Math.max(0, maxRetries - failure.retryCount);
    const needsManualRemediation = !failure.retryable || retriesRemaining === 0;

    const actions: OperatorAction[] = ['inspect'];
    if (failure.retryable && retriesRemaining > 0) actions.push('retry');
    actions.push('resolve', 'archive');

    totals.unresolved += 1;
    if (failure.severity === 'critical') totals.critical += 1;
    if (stale) totals.stale += 1;
    if (needsManualRemediation) totals.needsManualRemediation += 1;
    if (failure.status === 'retrying') totals.retrying += 1;
    byOperationType[failure.operationType] = (byOperationType[failure.operationType] ?? 0) + 1;

    queue.push({
      id: failure.id,
      operationType: failure.operationType,
      externalRef: failure.externalRef,
      severity: failure.severity,
      status: failure.status,
      ageMs,
      stale,
      retryCount: failure.retryCount,
      retriesRemaining,
      needsManualRemediation,
      actions,
    });
  }

  queue.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      Number(b.stale) - Number(a.stale) ||
      b.ageMs - a.ageMs ||
      a.id.localeCompare(b.id),
  );

  const limit = opts.limit === undefined ? queue.length : Math.max(0, Math.floor(opts.limit));

  return {
    generatedAt: new Date(now).toISOString(),
    totals,
    byOperationType,
    queue: queue.slice(0, limit),
  };
}
