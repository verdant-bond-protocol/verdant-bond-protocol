/**
 * Recovery checkpoints around every external side effect (issue #405).
 *
 * An *external side effect* is anything the process cannot undo by itself: an
 * on-chain submission, a webhook call, an email, a third-party API write. The
 * danger case is an **ambiguous failure** — the request may or may not have
 * been applied before the timeout. Blindly re-running a non-idempotent effect
 * can double-apply it; never re-running it can leave it missing.
 *
 * A checkpoint records enough state to decide, deterministically, whether the
 * effect still needs to happen:
 *
 *  - `started`   intent recorded, effect not yet known to have completed
 *  - `applied`   effect is known to have taken effect
 *  - `failed`    effect did NOT take effect (safe to retry)
 *  - `unknown`   the call failed ambiguously; a probe has not resolved it yet
 *  - `verified`  a probe confirmed the effect applied after an ambiguous failure
 */
export type SideEffectState = 'started' | 'applied' | 'failed' | 'unknown' | 'verified';

export interface SideEffectCheckpoint {
  /** Idempotency key, unique per side effect (and per logical attempt group). */
  key: string;
  description: string;
  state: SideEffectState;
  attempts: number;
  startedAt: string;
  updatedAt: string;
  appliedAt?: string;
  lastError?: string;
  /** Caller-supplied context stored for a later resume/probe. */
  context?: Record<string, any>;
}

export interface SideEffectRunOptions {
  /** Unique idempotency key for this side effect. */
  key: string;
  /** Human-readable purpose, stored on the checkpoint. */
  description?: string;
  /** Performs the side effect. Should be made idempotent where possible. */
  execute: () => Promise<void>;
  /**
   * After an ambiguous failure, decide whether the effect actually landed.
   * Returning `true` marks the checkpoint `verified` (applied) instead of
   * `unknown`, so a resume does not re-run it.
   */
  probe?: () => Promise<boolean>;
  /** Context persisted on the checkpoint for later repair/resume. */
  context?: Record<string, any>;
}

export class SideEffectError extends Error {
  constructor(
    message: string,
    public readonly key: string,
    public readonly state: SideEffectState,
  ) {
    super(message);
    this.name = 'SideEffectError';
  }
}
