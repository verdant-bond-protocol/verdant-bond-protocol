export type RunbookCheckStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface RunbookCheckInput {
  actorRole: 'operator' | 'auditor' | 'viewer';
  targetEnvironment: 'testnet' | 'staging' | 'production';
  allowProduction: boolean;
  checks: {
    databaseReachable: () => Promise<boolean>;
    redisReachable: () => Promise<boolean>;
    sorobanRpcHealthy: () => Promise<boolean>;
    pendingRecoveryCount: () => Promise<number>;
  };
  maxPendingRecoveries?: number;
  retries?: number;
}

export interface RunbookCheckItem {
  name: string;
  status: RunbookCheckStatus;
  attempts: number;
  detail?: string;
}

export interface RunbookVerificationReport {
  ok: boolean;
  environment: RunbookCheckInput['targetEnvironment'];
  items: RunbookCheckItem[];
}

export class RunbookAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunbookAuthorizationError';
  }
}

async function runWithRetry(
  name: string,
  fn: () => Promise<boolean>,
  retries: number,
): Promise<RunbookCheckItem> {
  let attempts = 0;
  let lastError: string | undefined;
  while (attempts <= retries) {
    attempts += 1;
    try {
      const ok = await fn();
      if (ok) {
        return { name, status: 'PASS', attempts };
      }
      lastError = `${name} returned false`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { name, status: 'FAIL', attempts, detail: lastError };
}

/**
 * Executes pre-flight and post-recovery incident runbook checks.
 * Enforces operator authorization and production safety guards.
 */
export async function executeIncidentRecoveryChecks(
  input: RunbookCheckInput,
): Promise<RunbookVerificationReport> {
  if (input.actorRole !== 'operator') {
    throw new RunbookAuthorizationError(
      `Role ${input.actorRole} is not authorized to execute incident recovery checks`,
    );
  }
  if (input.targetEnvironment === 'production' && !input.allowProduction) {
    throw new RunbookAuthorizationError(
      'Production recovery checks require explicit allowProduction=true confirmation',
    );
  }

  const retries = Math.max(0, input.retries ?? 1);
  const maxPending = input.maxPendingRecoveries ?? 0;

  const items: RunbookCheckItem[] = [];
  items.push(await runWithRetry('database-connectivity', input.checks.databaseReachable, retries));
  items.push(await runWithRetry('redis-connectivity', input.checks.redisReachable, retries));
  items.push(await runWithRetry('soroban-rpc-health', input.checks.sorobanRpcHealthy, retries));

  let backlogAttempts = 0;
  let backlogOk = false;
  let backlogDetail: string | undefined;
  while (backlogAttempts <= retries) {
    backlogAttempts += 1;
    try {
      const count = await input.checks.pendingRecoveryCount();
      if (count <= maxPending) {
        backlogOk = true;
        backlogDetail = `pending=${count} (limit=${maxPending})`;
        break;
      }
      backlogDetail = `pending=${count} exceeds limit=${maxPending}`;
    } catch (err) {
      backlogDetail = err instanceof Error ? err.message : String(err);
    }
  }
  items.push({
    name: 'pending-recovery-backlog',
    status: backlogOk ? 'PASS' : 'FAIL',
    attempts: backlogAttempts,
    detail: backlogDetail,
  });

  return {
    ok: items.every((item) => item.status === 'PASS'),
    environment: input.targetEnvironment,
    items,
  };
}
