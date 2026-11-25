/** Types for the dry-run repair tool with resumable checkpoints. */

export type RepairStepState = 'pending' | 'applied' | 'skipped' | 'failed' | 'rolled-back';
export type RepairRunState = 'planned' | 'applying' | 'applied' | 'failed' | 'rolled-back';

export interface RepairStep {
  /** Stable id — part of the plan digest, so reordering/renaming is detected. */
  id: string;
  description: string;
  /** READ-ONLY check: true when the state is already healthy (nothing to do). */
  inspect: () => boolean | Promise<boolean>;
  /** Idempotent repair write. Must be safe to retry after a checkpoint. */
  apply: () => void | Promise<void>;
  /** Compensating action; steps are rolled back in reverse order. */
  rollback?: () => void | Promise<void>;
}

export interface RepairJob {
  id: string;
  description: string;
  steps: RepairStep[];
}

export interface RepairActor {
  id: string;
  permissions: string[];
}

export interface CheckpointedStep {
  id: string;
  description: string;
  state: RepairStepState;
  attempts: number;
  lastError?: string;
}

export interface RepairCheckpoint {
  runId: string;
  jobId: string;
  planDigest: string;
  state: RepairRunState;
  actor: string;
  startedAt: string;
  updatedAt: string;
  steps: CheckpointedStep[];
}

export interface RepairReportStep {
  id: string;
  description: string;
  state: RepairStepState;
  healthy: boolean;
  lastError?: string;
}

export interface RepairReport {
  runId: string;
  jobId: string;
  mode: 'dry-run' | 'apply' | 'rollback';
  status: 'completed' | 'incomplete' | 'failed';
  planDigest: string;
  steps: RepairReportStep[];
  counters: { applied: number; skipped: number; failed: number; rolledBack: number };
  error?: string;
}

export class RepairRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepairRefusedError';
  }
}

export class RepairAuthorizationError extends RepairRefusedError {
  constructor(message: string) {
    super(message);
    this.name = 'RepairAuthorizationError';
  }
}

/** Read-only planning requires read access; writes require the repair scope. */
export function canPlan(actor: RepairActor): boolean {
  return actor.permissions.includes('ops:read') || canApply(actor);
}

export function canApply(actor: RepairActor): boolean {
  return actor.permissions.includes('ops:repair');
}
