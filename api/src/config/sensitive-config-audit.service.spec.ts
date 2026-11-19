import {
  SensitiveConfigAuditService,
  SensitiveConfigAuthorizationError,
  SensitiveConfigConflictError,
} from './sensitive-config-audit.service';

describe('SensitiveConfigAuditService (#528)', () => {
  it('normal path: applies sensitive config change, redacts secrets, and maintains valid hash chain', async () => {
    const svc = new SensitiveConfigAuditService({
      JWT_EXPIRY: '15m',
      SIGNING_SECRET_ROTATION_KEY: 'super-secret-value',
    });

    const res = await svc.applyChange({
      changeId: 'chg-001',
      actorId: 'admin-alice',
      actorRole: 'ADMIN',
      reason: 'Tighten slippage limit during volatility',
      updates: { MAX_SLIPPAGE_BPS: '50' },
    });

    expect(res.status).toBe('applied');
    expect(res.entry?.changedKeys).toEqual(['MAX_SLIPPAGE_BPS']);
    expect(res.entry?.before.SIGNING_SECRET_ROTATION_KEY).toBe('[REDACTED]');
    expect(res.entry?.after.MAX_SLIPPAGE_BPS).toBe('50');
    expect(svc.verifyChain()).toBe(true);
  });

  it('failure & rollback path: does not mutate state if audit sink fails, and supports verified rollback', async () => {
    let failPersist = true;
    const svc = new SensitiveConfigAuditService(
      { ORACLE_QUORUM: '3' },
      async () => {
        if (failPersist) {
          throw new Error('Audit sink unavailable');
        }
      },
    );

    await expect(
      svc.applyChange({
        changeId: 'chg-002',
        actorId: 'admin-alice',
        actorRole: 'ADMIN',
        reason: 'Increase quorum',
        updates: { ORACLE_QUORUM: '5' },
      }),
    ).rejects.toThrow('Audit sink unavailable');

    // State must remain unchanged when evidence cannot be written
    expect(svc.getSnapshot().ORACLE_QUORUM).toBe('3');
    expect(svc.getAuditTrail()).toHaveLength(0);

    // Retry succeeds once sink recovers
    failPersist = false;
    const applied = await svc.applyChange({
      changeId: 'chg-002',
      actorId: 'admin-alice',
      actorRole: 'ADMIN',
      reason: 'Increase quorum',
      updates: { ORACLE_QUORUM: '5' },
    });
    expect(applied.status).toBe('applied');
    expect(svc.getSnapshot().ORACLE_QUORUM).toBe('5');

    // Rollback restores prior value and appends new evidenced entry
    const rolledBack = await svc.rollbackChange({
      changeId: 'chg-003',
      targetChangeId: 'chg-002',
      actorId: 'admin-alice',
      actorRole: 'ADMIN',
      reason: 'Revert quorum change',
    });
    expect(rolledBack.status).toBe('rolled_back');
    expect(svc.getSnapshot().ORACLE_QUORUM).toBe('3');
    expect(svc.verifyChain()).toBe(true);
  });

  it('retry path: same changeId + payload replays idempotently; different payload throws conflict', async () => {
    const svc = new SensitiveConfigAuditService({ MAINTENANCE_MODE: 'false' });

    const first = await svc.applyChange({
      changeId: 'chg-idem-1',
      actorId: 'admin-alice',
      actorRole: 'ADMIN',
      reason: 'Enable maintenance mode',
      updates: { MAINTENANCE_MODE: 'true' },
    });
    expect(first.status).toBe('applied');

    const replay = await svc.applyChange({
      changeId: 'chg-idem-1',
      actorId: 'admin-alice',
      actorRole: 'ADMIN',
      reason: 'Enable maintenance mode',
      updates: { MAINTENANCE_MODE: 'true' },
    });
    expect(replay.status).toBe('replayed');
    expect(svc.getAuditTrail()).toHaveLength(1);

    await expect(
      svc.applyChange({
        changeId: 'chg-idem-1',
        actorId: 'admin-alice',
        actorRole: 'ADMIN',
        reason: 'Enable maintenance mode',
        updates: { MAINTENANCE_MODE: 'false' },
      }),
    ).rejects.toThrow(SensitiveConfigConflictError);
  });

  it('authorization path: rejects non-ADMIN actors before mutating config or audit trail', async () => {
    const svc = new SensitiveConfigAuditService({ JWT_EXPIRY: '15m' });

    await expect(
      svc.applyChange({
        changeId: 'chg-unauth',
        actorId: 'investor-bob',
        actorRole: 'INVESTOR',
        reason: 'Unauthorized change',
        updates: { JWT_EXPIRY: '365d' },
      }),
    ).rejects.toThrow(SensitiveConfigAuthorizationError);

    expect(svc.getSnapshot().JWT_EXPIRY).toBe('15m');
    expect(svc.getAuditTrail()).toHaveLength(0);
  });
});
