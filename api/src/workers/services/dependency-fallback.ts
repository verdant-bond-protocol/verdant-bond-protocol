import { DependencyState } from '../../health/health.interface';
import { JobType } from '../interfaces/job.interface';
import { FallbackDecision, FallbackStrategy } from '../interfaces/job-recovery.interface';

/**
 * Dependency degradation matrix and fallback behavior for background work.
 *
 * Pure data + pure decision function: no I/O, no timers, fully deterministic so
 * it can be exhaustively tested and rendered as documentation. The matrix is
 * the single source of truth for "when dependency X is in state Y, what should
 * the worker do?" — see docs/DEPENDENCY_DEGRADATION_MATRIX.md.
 */

export type DependencyName = 'redis' | 'rpc' | 'ipfs' | 'postgres';

export interface MatrixRule {
  strategy: FallbackStrategy;
  retryable: boolean;
  maxRetries: number;
  backoffMs: number;
  message: string;
  fallbackSource?: string;
  affectsJobTypes: JobType[];
}

const ALL_JOBS = Object.values(JobType);
const ONCHAIN_JOBS: JobType[] = [
  JobType.RECONCILIATION,
  JobType.COUPON_DISTRIBUTION,
  JobType.ORACLE_SYNC,
];

export const DEPENDENCY_FALLBACK_MATRIX: Record<
  DependencyName,
  Record<DependencyState, MatrixRule>
> = {
  redis: {
    operational: {
      strategy: 'proceed', retryable: true, maxRetries: 3, backoffMs: 500,
      message: 'Queue is healthy; process normally.', affectsJobTypes: ALL_JOBS,
    },
    degraded: {
      strategy: 'retry', retryable: true, maxRetries: 3, backoffMs: 1_000,
      message: 'Queue is degraded; retry with backoff, never shed an admitted job.',
      affectsJobTypes: ALL_JOBS,
    },
    down: {
      strategy: 'fail_closed', retryable: false, maxRetries: 0, backoffMs: 0,
      message: 'Queue is unavailable; reject new work rather than lose jobs.',
      affectsJobTypes: ALL_JOBS,
    },
    unknown: {
      strategy: 'fail_closed', retryable: false, maxRetries: 0, backoffMs: 0,
      message: 'Queue health is unknown; fail closed until it can be verified.',
      affectsJobTypes: ALL_JOBS,
    },
  },
  rpc: {
    operational: {
      strategy: 'proceed', retryable: true, maxRetries: 3, backoffMs: 1_000,
      message: 'RPC is healthy; submit normally.', affectsJobTypes: ONCHAIN_JOBS,
    },
    degraded: {
      strategy: 'retry', retryable: true, maxRetries: 5, backoffMs: 2_000,
      message: 'RPC is flaky; retry with backoff and probe before re-submitting on-chain effects.',
      affectsJobTypes: ONCHAIN_JOBS,
    },
    down: {
      strategy: 'degrade', retryable: true, maxRetries: 5, backoffMs: 5_000,
      message: 'RPC is down; queue on-chain work for later and serve cached reads.',
      affectsJobTypes: ONCHAIN_JOBS,
    },
    unknown: {
      strategy: 'retry', retryable: true, maxRetries: 3, backoffMs: 2_000,
      message: 'RPC health is unknown; treat as transient and retry with a probe.',
      affectsJobTypes: ONCHAIN_JOBS,
    },
  },
  ipfs: {
    operational: {
      strategy: 'proceed', retryable: true, maxRetries: 2, backoffMs: 500,
      message: 'Gateway is healthy; fetch normally.', affectsJobTypes: [JobType.DATA_EXPORT],
    },
    degraded: {
      strategy: 'fallback', retryable: true, maxRetries: 2, backoffMs: 500,
      message: 'Primary gateway degraded; use fallback gateways.',
      fallbackSource: 'fallback-gateways',
      affectsJobTypes: [JobType.DATA_EXPORT],
    },
    down: {
      strategy: 'fallback', retryable: false, maxRetries: 0, backoffMs: 0,
      message: 'All gateways down; serve the local content cache, marked as degraded.',
      fallbackSource: 'local-cache',
      affectsJobTypes: [JobType.DATA_EXPORT],
    },
    unknown: {
      strategy: 'fallback', retryable: true, maxRetries: 2, backoffMs: 500,
      message: 'Gateway health unknown; try fallbacks before failing.',
      fallbackSource: 'fallback-gateways',
      affectsJobTypes: [JobType.DATA_EXPORT],
    },
  },
  postgres: {
    operational: {
      strategy: 'proceed', retryable: true, maxRetries: 2, backoffMs: 500,
      message: 'Database is healthy; persist normally.', affectsJobTypes: ALL_JOBS,
    },
    degraded: {
      strategy: 'retry', retryable: true, maxRetries: 3, backoffMs: 1_000,
      message: 'Database is degraded; retry writes, keep the job in the queue.',
      affectsJobTypes: ALL_JOBS,
    },
    down: {
      strategy: 'fail_closed', retryable: false, maxRetries: 0, backoffMs: 0,
      message: 'Database is down; keep jobs queued, do not mark them successful.',
      affectsJobTypes: ALL_JOBS,
    },
    unknown: {
      strategy: 'fail_closed', retryable: false, maxRetries: 0, backoffMs: 0,
      message: 'Database health unknown; fail closed to avoid false completion.',
      affectsJobTypes: ALL_JOBS,
    },
  },
};

/** The four health states every dependency must define a rule for. */
export const COVERED_STATES: DependencyState[] = [
  'operational', 'degraded', 'down', 'unknown',
];

export interface FallbackContext {
  /** Override the rule's retry budget (e.g. an admin recovery re-queue). */
  maxRetries?: number;
}

/** Pure lookup: unknown dependency/state pairs fail closed, never throw. */
export function decideFallback(
  dependency: DependencyName | string,
  state: DependencyState | string,
  context: FallbackContext = {},
): FallbackDecision {
  const rule = (DEPENDENCY_FALLBACK_MATRIX as Record<string, Record<string, MatrixRule>>)[
    dependency
  ]?.[state];

  if (!rule) {
    return {
      dependency: String(dependency),
      state: String(state),
      strategy: 'fail_closed',
      retryable: false,
      maxRetries: 0,
      backoffMs: 0,
      message: 'No fallback rule for this dependency/state pair; failing closed.',
      affectsJobTypes: [],
    };
  }

  return {
    dependency,
    state,
    ...rule,
    maxRetries: context.maxRetries ?? rule.maxRetries,
  };
}

/** Verify every dependency defines every state (used by an executable test). */
export function matrixGaps(): Array<{ dependency: DependencyName; state: DependencyState }> {
  const gaps: Array<{ dependency: DependencyName; state: DependencyState }> = [];
  for (const dependency of Object.keys(DEPENDENCY_FALLBACK_MATRIX) as DependencyName[]) {
    for (const state of COVERED_STATES) {
      if (!DEPENDENCY_FALLBACK_MATRIX[dependency]?.[state]) gaps.push({ dependency, state });
    }
  }
  return gaps;
}
