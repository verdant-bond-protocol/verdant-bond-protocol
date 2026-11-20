/**
 * Contracts for the degraded-workflow resilience vertical slice.
 *
 * This module deliberately re-uses the existing public status schema and the
 * existing failure-injection result shape rather than inventing parallel
 * ones. `RESILIENCE_CONTRACT_VERSION` is bumped only when a wire-visible
 * field is added, removed or renamed (see docs/RESILIENCE_SLICE.md).
 */

import type {
  FlowType,
  SimulationResult,
} from '../failures/failure-injection.interface';
import type { OverallStatus, StatusReport } from '../status/status.interface';

export const RESILIENCE_CONTRACT_VERSION = 1 as const;

/** Public status component a critical workflow is mapped onto. */
export type WorkflowComponent = 'settlement' | 'redemption';

/** How a workflow came out of an injected (or normal) execution. */
export type RecoveryAction =
  | 'NONE'
  | 'AUTO_RETRY'
  | 'OPERATOR_RECOVERY_REQUIRED';

export interface ExecuteWorkflowRequest {
  workflow: FlowType;
  bondId: number;
  /** Decimal string so values above Number.MAX_SAFE_INTEGER stay lossless. */
  amount: string;
  /** Recipient (payout) or holder (redemption) address. */
  counterPartyAddress: string;
  idempotencyKey?: string;
  /** Caller role, checked against the effective role map. */
  actorRole: string;
  /** Wallet address used to attribute degradation and recovery. */
  actorAddress: string;
  /** Optional deterministic clock for tests/replay. */
  now?: number;
}

export interface DegradedDependencyView {
  component: string;
  /** Safe, user-facing explanation. Never contains internal error text. */
  message: string;
  mutationAllowed: boolean;
}

/**
 * The user-facing view of degraded dependencies. It embeds the existing
 * `StatusReport` unchanged so existing status consumers keep working, and
 * adds a plain-language headline derived from it.
 */
export interface UserFacingDependencyStatus {
  contractVersion: typeof RESILIENCE_CONTRACT_VERSION;
  generatedAt: string;
  overallStatus: OverallStatus;
  headline: string;
  degraded: DegradedDependencyView[];
  report: StatusReport;
}

export interface WorkflowExecutionResult {
  contractVersion: typeof RESILIENCE_CONTRACT_VERSION;
  workflow: FlowType;
  component: WorkflowComponent;
  simulation: SimulationResult;
  userStatus: UserFacingDependencyStatus;
  recordedFailureId?: string;
  recovered: boolean;
  recoveryAction: RecoveryAction;
}

/** The role map the workflow permission gate evaluates. */
export type RoleMap = Record<string, string[]>;

/** Stable permission required to drive each workflow. */
export const WORKFLOW_REQUIRED_PERMISSION: Record<FlowType, string> = {
  PAYOUT: 'bond:distribute-coupon',
  REDEMPTION: 'credit:claim',
};

/** Safe default notices, keyed by public component name. */
export const DEFAULT_DEGRADED_NOTICES: Record<string, string> = {
  settlement: 'Settlements are being retried automatically. No action is needed right now.',
  redemption: 'Redemptions are temporarily unavailable while we reconcile the pool. Please retry shortly.',
  cache: 'List and detail views may be slower than usual.',
  'oracle-monitoring': 'Some market data may be delayed.',
};
