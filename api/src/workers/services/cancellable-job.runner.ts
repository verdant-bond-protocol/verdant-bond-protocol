/**
 * Safe cancellation and cleanup for long-running jobs (issue #536).
 *
 * Builds on the cooperative {@link OperationCancellationService} (#404):
 *
 * - A job is a sequence of named steps. Cancellation is checked *between*
 *   steps, never mid-step, so a step's write is either fully done or not
 *   started.
 * - Each step may register a cleanup (compensation) handler. On cancellation,
 *   failure or timeout, the cleanups of completed steps run in reverse order
 *   (LIFO). A failing cleanup is recorded and the remaining cleanups still run.
 * - Completed step names are returned as a checkpoint; passing it back as
 *   `resumeFrom` skips those steps, so a retry after cancellation is safe and
 *   does not repeat side effects.
 * - Only the owner who started a job, or an admin, may cancel it.
 * - The registry entry is always released, so a cancelled id can be restarted.
 */

import {
  CancellationToken,
  OperationCancellationService,
  OperationCancelledError,
} from '../../common/services/operation-cancellation.service';

export interface JobStep {
  name: string;
  run: (token: CancellationToken) => Promise<void> | void;
  /** Undo this step's side effects. Must be idempotent. */
  cleanup?: () => Promise<void> | void;
}

export type JobOutcome = 'completed' | 'cancelled' | 'failed' | 'timed_out';

export interface JobRunResult {
  jobId: string;
  outcome: JobOutcome;
  completedSteps: string[];
  cleanedUpSteps: string[];
  cleanupErrors: Array<{ step: string; message: string }>;
  error?: string;
}

export interface RunJobOptions {
  jobId: string;
  ownerId: string;
  kind?: string;
  steps: readonly JobStep[];
  /** Step names already completed by a previous attempt. */
  resumeFrom?: readonly string[];
  timeoutMs?: number;
  /** Skip compensation on failure and keep the checkpoint for a resume. */
  cleanupOnFailure?: boolean;
}

export class JobCancellationForbiddenError extends Error {
  constructor(jobId: string) {
    super(`Not allowed to cancel job ${jobId}`);
    this.name = 'JobCancellationForbiddenError';
  }
}

export class CancellableJobRunner {
  private readonly owners = new Map<string, string>();

  constructor(private readonly cancellation: OperationCancellationService) {}

  async run(opts: RunJobOptions): Promise<JobRunResult> {
    const names = new Set<string>();
    for (const step of opts.steps) {
      if (!step.name || names.has(step.name)) throw new Error(`duplicate or empty step name: ${step.name}`);
      names.add(step.name);
    }

    const token = this.cancellation.start(opts.jobId, opts.kind ?? 'job');
    this.owners.set(opts.jobId, opts.ownerId);
    const resumed = new Set(opts.resumeFrom ?? []);
    const completed: JobStep[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        this.cancellation.cancel(opts.jobId, 'timeout');
      }, opts.timeoutMs);
    }

    const result: JobRunResult = {
      jobId: opts.jobId,
      outcome: 'completed',
      completedSteps: [...resumed].filter((name) => names.has(name)),
      cleanedUpSteps: [],
      cleanupErrors: [],
    };

    try {
      for (const step of opts.steps) {
        if (resumed.has(step.name)) continue;
        token.throwIfCancelled();
        await step.run(token);
        completed.push(step);
        result.completedSteps.push(step.name);
      }
      // A cancel that lands during the final step still wins: the caller asked
      // to stop and the work must be rolled back consistently.
      token.throwIfCancelled();
    } catch (error) {
      const cancelled = error instanceof OperationCancelledError;
      result.outcome = cancelled ? (timedOut ? 'timed_out' : 'cancelled') : 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      if (cancelled || opts.cleanupOnFailure !== false) {
        await this.compensate(completed, result);
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.cancellation.release(opts.jobId);
      this.owners.delete(opts.jobId);
    }
    return result;
  }

  /**
   * Request cancellation. Returns false for an unknown or already-cancelled
   * job (idempotent). Throws when the caller is neither owner nor admin.
   */
  cancel(jobId: string, actor: { id: string; isAdmin?: boolean }, reason = 'cancelled by user'): boolean {
    const owner = this.owners.get(jobId);
    if (owner === undefined) return false;
    if (owner !== actor.id && !actor.isAdmin) throw new JobCancellationForbiddenError(jobId);
    return this.cancellation.cancel(jobId, reason);
  }

  private async compensate(completed: JobStep[], result: JobRunResult): Promise<void> {
    for (const step of [...completed].reverse()) {
      if (!step.cleanup) continue;
      try {
        await step.cleanup();
        result.cleanedUpSteps.push(step.name);
      } catch (error) {
        result.cleanupErrors.push({ step: step.name, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const cleaned = new Set(result.cleanedUpSteps);
    // Rolled-back steps are no longer completed; a resume must redo them.
    result.completedSteps = result.completedSteps.filter((name) => !cleaned.has(name));
  }
}
