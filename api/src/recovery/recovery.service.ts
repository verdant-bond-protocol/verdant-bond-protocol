import { Injectable, Logger } from '@nestjs/common';
import {
  RecoveryCheckpoint,
  RecoveryDiagnostic,
  RecoveryOperation,
  RecoveryOperationStatus,
  RecoveryStepDefinition,
  RecoveryUserAction,
} from './recovery.interface';

/**
 * Threshold for the maintainer diagnostics listing. Operations interrupted
 * longer than this are surfaced as "stuck"; those interrupted longer than
 * `abandonAfterMs` can be marked abandoned by an operator.
 */
export const DEFAULT_STUCK_AFTER_MS = 30 * 60 * 1000;
export const DEFAULT_ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Deterministic recovery for interrupted multi-step operations (issue #261).
 *
 * An operation declares a **fixed** ordered list of steps. Each time a step
 * finishes, a checkpoint is recorded atomically with the step id, index and
 * the state needed to continue. `resume` therefore has exactly one legal
 * behaviour for any (operation, checkpoint) pair:
 *
 * 1. walk `steps` in declared order (the list is never mutated),
 * 2. skip steps strictly before the last checkpoint's index,
 * 3. for a side-effect step already flagged applied, skip without calling
 *    `run` again,
 * 4. run the remaining steps, checkpointing after each.
 *
 * Re-entrancy is safe: resuming twice in a row produces the same result
 * because completed steps are skipped and side-effect steps consult
 * `sideEffectsApplied` before running.
 */
@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);
  private readonly operations = new Map<string, RecoveryOperation>();
  private readonly userActions = new Map<string, RecoveryUserAction[]>();
  private readonly auditEvents: Array<Record<string, any>> = [];

  /**
   * Declare a new operation. Steps are copied defensively so a later change to
   * the caller's array cannot retroactively make a resumed run nondeterministic.
   */
  async start(type: string, steps: RecoveryStepDefinition[], state: Record<string, any> = {}): Promise<RecoveryOperation> {
    if (!steps || steps.length === 0) {
      throw new Error('an operation requires at least one step');
    }
    const ids = new Set(steps.map((s) => s.id));
    if (ids.size !== steps.length) {
      throw new Error('step ids must be unique within an operation');
    }

    const operationId = `op_${type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    const operation: RecoveryOperation = {
      operationId,
      type,
      steps: steps.map((s) => ({ ...s })),
      checkpoints: [],
      status: RecoveryOperationStatus.NOT_STARTED,
      createdAt: now,
      updatedAt: now,
      resumeAttempts: 0,
    };
    this.operations.set(operationId, operation);
    await this.checkpoint(operation, 0, state, RecoveryOperationStatus.NOT_STARTED);
    return operation;
  }

  /**
   * Run the operation from its last checkpoint. Deterministic: same inputs,
   * same step order, no duplicate side effects.
   */
  async resume(operationId: string): Promise<RecoveryOperation> {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`unknown operation: ${operationId}`);
    }

    const last = operation.checkpoints[operation.checkpoints.length - 1];
    if (last && (last.status === RecoveryOperationStatus.COMPLETED)) {
      return operation; // nothing to do, idempotent
    }
    if (last && last.status === RecoveryOperationStatus.ABANDONED) {
      throw new Error(`operation ${operationId} was abandoned; cannot resume`);
    }

    operation.resumeAttempts++;
    operation.status = RecoveryOperationStatus.RECOVERING;
    this.audit('resume_started', operation, last?.stepIndex ?? 0);

    let state: Record<string, any> = last?.state ?? {};
    let startIndex = (last?.stepIndex ?? 0);

    for (let index = startIndex; index < operation.steps.length; index++) {
      const step = operation.steps[index];

      // Skip steps already checkpointed as done.
      if (last && index === last.stepIndex && last.status === RecoveryOperationStatus.COMPLETED) {
        continue;
      }

      operation.status = RecoveryOperationStatus.RUNNING;
      operation.updatedAt = new Date().toISOString();

      try {
        // Side-effect guard: never re-run an irreversible step whose effect
        // is already known to be applied.
        if (step.hasExternalSideEffect && step.sideEffectsApplied) {
          const alreadyApplied = await step.sideEffectsApplied(state);
          if (alreadyApplied) {
            await this.checkpoint(operation, index, state, RecoveryOperationStatus.COMPLETED, step.id);
            continue;
          }
        }

        state = (await step.run(state)) ?? state;
        await this.checkpoint(operation, index, state, RecoveryOperationStatus.COMPLETED, step.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.checkpoint(operation, index, state, RecoveryOperationStatus.INTERRUPTED, step.id, message);
        this.recordUserAction(operation, step, message);
        this.audit('interrupted', operation, index, message);
        return operation; // deterministic stop: nothing after this runs
      }
    }

    operation.status = RecoveryOperationStatus.COMPLETED;
    operation.completedAt = new Date().toISOString();
    operation.updatedAt = operation.completedAt;
    await this.checkpoint(operation, operation.steps.length - 1, state, RecoveryOperationStatus.COMPLETED);
    this.audit('completed', operation, operation.steps.length - 1);
    return operation;
  }

  /** Next actionable step for the user, from the last checkpoint. */
  getUserActions(operationId: string): RecoveryUserAction[] {
    return this.userActions.get(operationId) ?? [];
  }

  getOperation(operationId: string): RecoveryOperation | undefined {
    return this.operations.get(operationId);
  }

  /**
   * Maintainer diagnostics: every non-terminal operation, oldest first, with
   * how long it has been sitting in its current state.
   */
  getDiagnostics(now = Date.now()): RecoveryDiagnostic[] {
    const out: RecoveryDiagnostic[] = [];
    for (const operation of this.operations.values()) {
      const last = operation.checkpoints[operation.checkpoints.length - 1];
      if (!last) continue;
      if (last.status === RecoveryOperationStatus.COMPLETED) continue;

      const updatedAt = new Date(operation.updatedAt).getTime();
      out.push({
        operationId: operation.operationId,
        type: operation.type,
        status: operation.status,
        stepId: last.stepId,
        stepIndex: last.stepIndex,
        interruptedForMs: Math.max(0, now - updatedAt),
        resumeAttempts: operation.resumeAttempts,
        lastError: operation.lastError,
        updatedAt: operation.updatedAt,
      });
    }
    return out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  /** Explicit operator decision; never called automatically. */
  async markAbandoned(operationId: string, olderThanMs = DEFAULT_ABANDON_AFTER_MS, now = Date.now()): Promise<boolean> {
    const operation = this.operations.get(operationId);
    if (!operation) return false;

    const last = operation.checkpoints[operation.checkpoints.length - 1];
    if (last && last.status === RecoveryOperationStatus.COMPLETED) return false;

    const updatedAt = new Date(operation.updatedAt).getTime();
    if (now - updatedAt < olderThanMs) return false;

    operation.status = RecoveryOperationStatus.ABANDONED;
    operation.updatedAt = new Date(now).toISOString();
    this.audit('abandoned', operation, last?.stepIndex ?? 0);
    return true;
  }

  getOperationCount(): number {
    return this.operations.size;
  }

  clear(): void {
    this.operations.clear();
    this.userActions.clear();
    this.auditEvents.length = 0;
  }

  private async checkpoint(
    operation: RecoveryOperation,
    stepIndex: number,
    state: Record<string, any>,
    status: RecoveryOperationStatus,
    stepId?: string,
    error?: string,
  ): Promise<void> {
    const step = operation.steps[Math.min(stepIndex, operation.steps.length - 1)];
    const checkpoint = {
      operationId: operation.operationId,
      stepId: stepId ?? step?.id ?? 'start',
      stepIndex,
      status,
      recordedAt: new Date().toISOString(),
      state: { ...state },
      error,
    };
    operation.checkpoints.push(checkpoint);
    operation.updatedAt = checkpoint.recordedAt;
    if (error) operation.lastError = error;
  }

  private recordUserAction(operation: RecoveryOperation, step: RecoveryStepDefinition, error: string): void {
    const actions = this.userActions.get(operation.operationId) ?? [];
    actions.push({
      operationId: operation.operationId,
      stepId: step.id,
      action: step.userAction ?? `Retry ${step.id} then continue`,
      status: RecoveryOperationStatus.INTERRUPTED,
    });
    this.userActions.set(operation.operationId, actions);
    this.logger.warn(`operation ${operation.operationId} interrupted at ${step.id}: ${error}`);
  }

  private audit(event: string, operation: RecoveryOperation, stepIndex: number, error?: string): void {
    this.auditEvents.push({
      event,
      operationId: operation.operationId,
      type: operation.type,
      stepIndex,
      error,
      at: new Date().toISOString(),
    });
  }
}
