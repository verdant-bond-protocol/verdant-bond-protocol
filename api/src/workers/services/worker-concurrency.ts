/**
 * Bounded worker concurrency (#557).
 *
 * `WorkerService` claims at most this many jobs at once. A worker whose slots
 * are all busy does not dequeue, so excess work waits in the queue (where
 * enqueue-time backpressure already bounds it) instead of piling up in memory
 * or hammering a downstream dependency.
 */

/** One job at a time: the behaviour before concurrency became configurable. */
export const DEFAULT_WORKER_CONCURRENCY = 1;

/** Hard ceiling so a typo such as 10000 cannot unbound the worker. */
export const MAX_WORKER_CONCURRENCY = 32;

/**
 * Resolve the concurrency bound from the environment.
 *
 *   WORKER_CONCURRENCY=<n>   jobs processed at once, 1..MAX_WORKER_CONCURRENCY
 *
 * A missing, non-integer or non-positive value keeps the default rather than
 * unbounding or stalling the worker; values above the ceiling are clamped.
 * Unsetting the variable is the rollback path.
 */
export function resolveWorkerConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.WORKER_CONCURRENCY);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_WORKER_CONCURRENCY;
  return Math.min(parsed, MAX_WORKER_CONCURRENCY);
}
