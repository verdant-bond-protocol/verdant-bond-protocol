import {
  executeIncidentRecoveryChecks,
  RunbookAuthorizationError,
} from './incident-recovery-runbook-checks';

describe('Incident recovery runbook checks (#544)', () => {
  it('passes all checks when dependencies are healthy and backlog is within limit', async () => {
    const report = await executeIncidentRecoveryChecks({
      actorRole: 'operator',
      targetEnvironment: 'staging',
      allowProduction: false,
      checks: {
        databaseReachable: async () => true,
        redisReachable: async () => true,
        sorobanRpcHealthy: async () => true,
        pendingRecoveryCount: async () => 0,
      },
    });

    expect(report.ok).toBe(true);
    expect(report.items).toHaveLength(4);
    expect(report.items.every((i) => i.status === 'PASS')).toBe(true);
  });

  it('retries transient dependency failure and succeeds on retry', async () => {
    let rpcCalls = 0;
    const report = await executeIncidentRecoveryChecks({
      actorRole: 'operator',
      targetEnvironment: 'testnet',
      allowProduction: false,
      retries: 1,
      checks: {
        databaseReachable: async () => true,
        redisReachable: async () => true,
        sorobanRpcHealthy: async () => {
          rpcCalls += 1;
          if (rpcCalls === 1) throw new Error('ETIMEDOUT');
          return true;
        },
        pendingRecoveryCount: async () => 0,
      },
    });

    expect(report.ok).toBe(true);
    expect(report.items.find((i) => i.name === 'soroban-rpc-health')).toMatchObject({
      status: 'PASS',
      attempts: 2,
    });
  });

  it('fails report when pending recovery backlog exceeds threshold', async () => {
    const report = await executeIncidentRecoveryChecks({
      actorRole: 'operator',
      targetEnvironment: 'staging',
      allowProduction: false,
      maxPendingRecoveries: 2,
      retries: 0,
      checks: {
        databaseReachable: async () => true,
        redisReachable: async () => true,
        sorobanRpcHealthy: async () => true,
        pendingRecoveryCount: async () => 5,
      },
    });

    expect(report.ok).toBe(false);
    expect(report.items.find((i) => i.name === 'pending-recovery-backlog')).toMatchObject({
      status: 'FAIL',
      detail: 'pending=5 exceeds limit=2',
    });
  });

  it('rejects non-operator roles and unconfirmed production execution', async () => {
    await expect(
      executeIncidentRecoveryChecks({
        actorRole: 'viewer',
        targetEnvironment: 'staging',
        allowProduction: false,
        checks: {
          databaseReachable: async () => true,
          redisReachable: async () => true,
          sorobanRpcHealthy: async () => true,
          pendingRecoveryCount: async () => 0,
        },
      }),
    ).rejects.toThrow(RunbookAuthorizationError);

    await expect(
      executeIncidentRecoveryChecks({
        actorRole: 'operator',
        targetEnvironment: 'production',
        allowProduction: false,
        checks: {
          databaseReachable: async () => true,
          redisReachable: async () => true,
          sorobanRpcHealthy: async () => true,
          pendingRecoveryCount: async () => 0,
        },
      }),
    ).rejects.toThrow(RunbookAuthorizationError);
  });
});
