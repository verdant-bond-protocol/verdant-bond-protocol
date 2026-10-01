export enum JobType {
  RECONCILIATION = 'reconciliation',
  DATA_EXPORT = 'data_export',
  COUPON_DISTRIBUTION = 'coupon_distribution',
  ORACLE_SYNC = 'oracle_sync',
  PORTFOLIO_REBALANCE = 'portfolio_rebalance',
}

export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SUCCESS = 'success',
  FAILED = 'failed',
  DEAD_LETTER = 'dead_letter',
}

export interface JobPayload {
  type: JobType;
  data: Record<string, any>;
  userId?: string;
  correlationId?: string;
}

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  payload: JobPayload;
  retries: number;
  maxRetries: number;
  lastError?: string;
  lastErrorAt?: Date;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: Record<string, any>;
}

export const DEFAULT_MAX_RETRIES = 3;
export const JOB_PROCESSING_TIMEOUT_MS = 300_000; // 5 minutes
