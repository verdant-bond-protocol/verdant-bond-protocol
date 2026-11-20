import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/errors/error-codes';
import { JobType } from '../interfaces/job.interface';

/**
 * Bounded-queue backpressure for expensive background work (#391).
 *
 * Admission is decided at enqueue time against three bounds:
 *
 *   - global:  total pending jobs across every type;
 *   - type:    pending jobs of one type (exports and reconciliations are the
 *              expensive ones, so they get the tightest bounds);
 *   - user:    pending jobs submitted by one non-privileged caller, so a single
 *              account cannot fill a type's whole budget.
 *
 * Privileged (admin/system) submissions skip the per-user bound and may use
 * `adminReserve` extra slots above the type and global bounds, so operators
 * can still run recovery work while user traffic has saturated the queue.
 *
 * Only admission is bounded. A job that was admitted is never shed: retries
 * re-queue it without passing admission again. See docs/queue-backpressure.md.
 */

export interface QueueTypeLimit {
  /** Pending jobs of this type admitted for non-privileged callers. */
  maxDepth: number;
  /** Pending jobs of this type one non-privileged caller may hold. */
  perUserMaxDepth: number;
  /** Extra slots above `maxDepth` that only privileged callers may use. */
  adminReserve: number;
  /** Retry-After hint returned when this type is saturated. */
  retryAfterSeconds: number;
}

export interface QueueLimits {
  enabled: boolean;
  globalMaxDepth: number;
  globalAdminReserve: number;
  types: Record<JobType, QueueTypeLimit>;
}

export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  enabled: true,
  globalMaxDepth: 1_000,
  globalAdminReserve: 50,
  types: {
    [JobType.DATA_EXPORT]: { maxDepth: 100, perUserMaxDepth: 3, adminReserve: 10, retryAfterSeconds: 60 },
    [JobType.RECONCILIATION]: { maxDepth: 5, perUserMaxDepth: 1, adminReserve: 2, retryAfterSeconds: 300 },
    [JobType.PORTFOLIO_REBALANCE]: { maxDepth: 200, perUserMaxDepth: 5, adminReserve: 10, retryAfterSeconds: 30 },
    [JobType.ORACLE_SYNC]: { maxDepth: 50, perUserMaxDepth: 5, adminReserve: 10, retryAfterSeconds: 60 },
    [JobType.COUPON_DISTRIBUTION]: { maxDepth: 500, perUserMaxDepth: 50, adminReserve: 50, retryAfterSeconds: 30 },
  },
};

/** How long one enqueue may hold the admission lock before it self-expires. */
export const ADMISSION_LOCK_TTL_MS = 5_000;
/** Attempts to take a contended admission lock before answering 429. */
export const ADMISSION_LOCK_ATTEMPTS = 5;
export const ADMISSION_LOCK_RETRY_MS = 20;

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Resolve limits from the environment. Every override is optional; a missing
 * or malformed value keeps the default rather than unbounding the queue.
 *
 *   JOB_QUEUE_BACKPRESSURE=off               kill switch (rollback path)
 *   JOB_QUEUE_MAX_DEPTH=<n>                  global bound
 *   JOB_QUEUE_ADMIN_RESERVE=<n>              global privileged headroom
 *   JOB_QUEUE_MAX_DEPTH_<TYPE>=<n>           per-type bound, e.g. _DATA_EXPORT
 *   JOB_QUEUE_USER_MAX_DEPTH_<TYPE>=<n>      per-user bound for a type
 */
export function resolveQueueLimits(env: NodeJS.ProcessEnv = process.env): QueueLimits {
  const types = {} as Record<JobType, QueueTypeLimit>;
  for (const type of Object.values(JobType)) {
    const base = DEFAULT_QUEUE_LIMITS.types[type];
    const suffix = type.toUpperCase();
    types[type] = {
      ...base,
      maxDepth: positiveInt(env[`JOB_QUEUE_MAX_DEPTH_${suffix}`], base.maxDepth),
      perUserMaxDepth: positiveInt(env[`JOB_QUEUE_USER_MAX_DEPTH_${suffix}`], base.perUserMaxDepth),
    };
  }
  return {
    enabled: env.JOB_QUEUE_BACKPRESSURE !== 'off',
    globalMaxDepth: positiveInt(env.JOB_QUEUE_MAX_DEPTH, DEFAULT_QUEUE_LIMITS.globalMaxDepth),
    globalAdminReserve: positiveInt(env.JOB_QUEUE_ADMIN_RESERVE, DEFAULT_QUEUE_LIMITS.globalAdminReserve),
    types,
  };
}

export type BackpressureScope = 'global' | 'type' | 'user' | 'contended';

export interface BackpressureDecision {
  admitted: boolean;
  scope?: BackpressureScope;
  depth?: number;
  limit?: number;
}

export interface QueueDepths {
  global: number;
  type: number;
  user: number;
}

/**
 * Pure admission rule, kept separate from Redis so every boundary can be
 * tested exhaustively. Bounds are checked tightest-first so the caller sees
 * the scope it can actually do something about.
 */
export function decideAdmission(
  limits: QueueLimits,
  type: JobType,
  depths: QueueDepths,
  privileged: boolean,
): BackpressureDecision {
  const typeLimit = limits.types[type];

  if (!privileged && depths.user >= typeLimit.perUserMaxDepth) {
    return { admitted: false, scope: 'user', depth: depths.user, limit: typeLimit.perUserMaxDepth };
  }

  const typeBound = typeLimit.maxDepth + (privileged ? typeLimit.adminReserve : 0);
  if (depths.type >= typeBound) {
    return { admitted: false, scope: 'type', depth: depths.type, limit: typeBound };
  }

  const globalBound = limits.globalMaxDepth + (privileged ? limits.globalAdminReserve : 0);
  if (depths.global >= globalBound) {
    return { admitted: false, scope: 'global', depth: depths.global, limit: globalBound };
  }

  return { admitted: true };
}

/**
 * 429 with a stable `QUEUE_BACKPRESSURE` code and a Retry-After hint. The job
 * was not persisted, so the caller may retry the same request unchanged.
 */
export class QueueBackpressureException extends HttpException {
  constructor(
    readonly jobType: JobType,
    readonly scope: BackpressureScope,
    readonly retryAfterSeconds: number,
    readonly depth?: number,
    readonly limit?: number,
  ) {
    super(
      {
        error: 'Queue Backpressure',
        code: ErrorCode.QUEUE_BACKPRESSURE,
        message: `Background queue for ${jobType} is saturated (${scope}); retry after ${retryAfterSeconds}s`,
        jobType,
        scope,
        depth,
        limit,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
