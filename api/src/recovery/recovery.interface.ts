/**
 * Recovery state machine for interrupted multi-step operations (issue #261).
 *
 * Determinism contract: for a given `(operationId, checkpoint)` pair, `resume`
 * always performs the same steps in the same order and never re-executes a
 * step whose external side effect has already been applied. Side effects are
 * guarded by idempotency keys derived from the operation and step ids, so
 * "wallet signed, API call half-sent, worker died" resumes from the last
 * committed checkpoint rather than replaying the mutation.
 */

export enum RecoveryOperationStatus {
  NOT_STARTED = 'not_started',
  RUNNING = 'running',
  AWAITING_EXTERNAL = 'awaiting_external',
  INTERRUPTED = 'interrupted',
  RECOVERING = 'recovering',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ABANDONED = 'abandoned',
}

/** Stable declaration of one step in a multi-step operation. */
export interface RecoveryStepDefinition {
  /** Stable identifier, e.g. 'reserve_subscription_slot'. */
  id: string;
  /** Executed when the step runs. Must be idempotent for side-effect steps. */
  run: (context: Record<string, any>) => Promise<Record<string, any>>;
  /** Human-readable next step surfaced to users when recovery is needed. */
  userAction?: string;
  /** Idempotency key for this step's external side effect. */
  idempotencyKey?: string;
  /**
   * True when this step performs an irreversible external effect (on-chain
   * submission, webhook dispatch, email). Such steps check
   * `sideEffectsApplied` before re-running on resume.
   */
  hasExternalSideEffect?: boolean;
  /** Predicate deciding whether this step's side effect already happened. */
  sideEffectsApplied?: (context: Record<string, any>) => Promise<boolean>;
}

export interface RecoveryCheckpoint {
  operationId: string;
  stepId: string;
  /** 0-based index into the operation's step list. */
  stepIndex: number;
  status: RecoveryOperationStatus;
  recordedAt: string;
  /** Free-form, JSON-serialisable state carried between steps. */
  state: Record<string, any>;
  error?: string;
}

export interface RecoveryOperation {
  operationId: string;
  type: string;
  /** Fixed step order — resume is deterministic because this never mutates. */
  steps: RecoveryStepDefinition[];
  checkpoints: RecoveryCheckpoint[];
  status: RecoveryOperationStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  lastError?: string;
  /** Bumped on every resume attempt; surfaced in maintainer diagnostics. */
  resumeAttempts: number;
}

/** One user-facing instruction produced when recovery is required. */
export interface RecoveryUserAction {
  operationId: string;
  stepId: string;
  action: string;
  status: RecoveryOperationStatus;
}

export interface RecoveryDiagnostic {
  operationId: string;
  type: string;
  status: RecoveryOperationStatus;
  stepId: string;
  stepIndex: number;
  interruptedForMs: number;
  resumeAttempts: number;
  lastError?: string;
  updatedAt: string;
}
