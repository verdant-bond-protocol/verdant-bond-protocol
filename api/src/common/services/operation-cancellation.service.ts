import { Injectable, Logger } from '@nestjs/common';

/**
 * Thrown by {@link CancellationToken.throwIfCancelled} when an operation has
 * been cancelled. Long-running work should let this propagate out of its inner
 * loop so it stops promptly and leaves a consistent, resumable state.
 */
export class OperationCancelledError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly reason?: string,
  ) {
    super(`Operation ${operationId} was cancelled${reason ? `: ${reason}` : ''}`);
    this.name = 'OperationCancelledError';
  }
}

export interface CancellationToken {
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  readonly reason?: string;
  /** Throws {@link OperationCancelledError} if the token has been cancelled. */
  throwIfCancelled(): void;
}

export interface ActiveOperation {
  operationId: string;
  kind: string;
  startedAt: string;
  cancelled: boolean;
  cancelledAt?: string;
  reason?: string;
}

interface Entry {
  controller: AbortController;
  kind: string;
  startedAt: string;
  cancelledAt?: string;
  reason?: string;
  token?: CancellationToken;
}

/**
 * Cooperative cancellation registry for long-running imports and exports
 * (issue #404).
 *
 * Cancellation is *cooperative*: a running operation is handed a
 * {@link CancellationToken} and must call `throwIfCancelled()` (or observe
 * `signal`) at safe points. That lets the operation stop **between** units of
 * work — never mid-write — so it leaves a consistent state that can be retried
 * or resumed. Cancelling an unknown or already-cancelled operation is a no-op,
 * which makes the control path idempotent and safe to retry.
 */
@Injectable()
export class OperationCancellationService {
  private readonly logger = new Logger(OperationCancellationService.name);
  private readonly entries = new Map<string, Entry>();

  /**
   * Register an operation and return its token. Calling this twice with the
   * same id returns the existing token rather than silently dropping the
   * first cancellation request.
   */
  start(operationId: string, kind = 'operation'): CancellationToken {
    const existing = this.entries.get(operationId);
    // Reuse a live token so a second `start` cannot drop a pending cancel.
    // A previously-cancelled entry is superseded (this is the retry path).
    if (existing && !existing.controller.signal.aborted) {
      existing.token = existing.token ?? this.toToken(operationId, existing);
      return existing.token;
    }
    const entry: Entry = {
      controller: new AbortController(),
      kind,
      startedAt: new Date().toISOString(),
    };
    entry.token = this.toToken(operationId, entry);
    this.entries.set(operationId, entry);
    return entry.token;
  }

  get(operationId: string): CancellationToken | undefined {
    const entry = this.entries.get(operationId);
    return entry ? this.toToken(operationId, entry) : undefined;
  }

  isCancelled(operationId: string): boolean {
    return this.entries.get(operationId)?.controller.signal.aborted ?? false;
  }

  /**
   * Request cancellation. Returns true only when this call actually flipped a
   * live, non-cancelled operation (so callers can distinguish a first cancel
   * from a duplicate).
   */
  cancel(operationId: string, reason = 'cancelled by operator'): boolean {
    const entry = this.entries.get(operationId);
    if (!entry || entry.controller.signal.aborted) {
      return false;
    }
    entry.reason = reason;
    entry.cancelledAt = new Date().toISOString();
    entry.controller.abort(reason);
    this.logger.warn(`operation ${operationId} cancelled: ${reason}`);
    return true;
  }

  /** Drop a finished operation from the registry. */
  release(operationId: string): void {
    this.entries.delete(operationId);
  }

  listActive(): ActiveOperation[] {
    return [...this.entries.entries()].map(([operationId, entry]) => ({
      operationId,
      kind: entry.kind,
      startedAt: entry.startedAt,
      cancelled: entry.controller.signal.aborted,
      cancelledAt: entry.cancelledAt,
      reason: entry.reason,
    }));
  }

  clear(): void {
    this.entries.clear();
  }

  private toToken(operationId: string, entry: Entry): CancellationToken {
    return {
      operationId,
      signal: entry.controller.signal,
      get cancelled() {
        return entry.controller.signal.aborted;
      },
      get reason() {
        return entry.reason;
      },
      throwIfCancelled: () => {
        if (entry.controller.signal.aborted) {
          throw new OperationCancelledError(operationId, entry.reason);
        }
      },
    };
  }
}
