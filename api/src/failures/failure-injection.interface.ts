export type FlowType = 'PAYOUT' | 'REDEMPTION';

export enum FailureMode {
  TRANSIENT_RPC_TIMEOUT = 'TRANSIENT_RPC_TIMEOUT',
  PRE_COMMIT_NETWORK_RESET = 'PRE_COMMIT_NETWORK_RESET',
  UNDERFUNDED_REDEMPTION_POOL = 'UNDERFUNDED_REDEMPTION_POOL',
  UNAUTHORIZED_CALLER = 'UNAUTHORIZED_CALLER',
  CONCURRENT_IDEMPOTENCY_REPLAY = 'CONCURRENT_IDEMPOTENCY_REPLAY',
  CORRUPTED_NONCE = 'CORRUPTED_NONCE',
}

export interface InjectionRule {
  id: string;
  flowType: FlowType;
  failureMode: FailureMode;
  bondId?: number;
  targetAddress?: string;
  remainingInjections: number;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
  description: string;
}

export interface CreateInjectionRuleDto {
  flowType: FlowType;
  failureMode: FailureMode;
  bondId?: number;
  targetAddress?: string;
  count?: number;
  description: string;
}

export interface FinancialInvariants {
  totalCreditsIssued: string;
  claimedCredits: string;
  undistributedCredits: string;
  redemptionPoolBalance: string;
  tokenSupply: string;
  heldBalancesSum: string;
  isConserved: boolean;
  details: string;
}

export interface SimulationResult {
  simulationId: string;
  flowType: FlowType;
  failureMode?: FailureMode;
  injected: boolean;
  attempts: number;
  recovered: boolean;
  recoveryMethod?: string;
  transactionHash?: string;
  partialFailureId?: string;
  preInvariants: FinancialInvariants;
  postInvariants: FinancialInvariants;
  invariantsPreserved: boolean;
  executionLog: string[];
}
