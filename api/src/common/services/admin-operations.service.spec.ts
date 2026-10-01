import { AdminOperationsService, FreezeWindow, OperationEvent } from './admin-operations.service';

describe('AdminOperationsService', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  const secret = 'test-secret';

  it('accepts valid approvals and rejects expired, wrong actor, wrong action and replayed approvals', () => {
    const service = new AdminOperationsService();
    const payload = {
      action: 'settlement.finalize',
      actor: 'maintainer-1',
      reason: 'release settlement',
      expiresAt: '2026-01-01T13:00:00.000Z',
      nonce: 'approval-1',
    };
    const approval = { ...payload, signature: service.expectedSignature(payload, secret) };

    expect(() => service.verifyApproval(approval, 'settlement.finalize', 'maintainer-1', now, secret)).not.toThrow();
    expect(() => service.verifyApproval(approval, 'settlement.finalize', 'maintainer-1', now, secret)).toThrow(/replay/);

    const expired = { ...payload, nonce: 'approval-2', expiresAt: '2026-01-01T11:00:00.000Z' };
    expect(() => service.verifyApproval(
      { ...expired, signature: service.expectedSignature(expired, secret) },
      'settlement.finalize',
      'maintainer-1',
      now,
      secret,
    )).toThrow(/expired/);

    const wrongActor = { ...payload, nonce: 'approval-3' };
    expect(() => service.verifyApproval(
      { ...wrongActor, signature: service.expectedSignature(wrongActor, secret) },
      'settlement.finalize',
      'other-maintainer',
      now,
      secret,
    )).toThrow(/actor/);

    const wrongAction = { ...payload, nonce: 'approval-4' };
    expect(() => service.verifyApproval(
      { ...wrongAction, signature: service.expectedSignature(wrongAction, secret) },
      'oracle.reconfigure',
      'maintainer-1',
      now,
      secret,
    )).toThrow(/action/);
  });

  it('blocks active freeze windows while ignoring expired and future windows', () => {
    const service = new AdminOperationsService();
    const windows: FreezeWindow[] = [
      { id: 'expired', scope: 'settlement.finalize', startsAt: '2026-01-01T08:00:00.000Z', endsAt: '2026-01-01T09:00:00.000Z', reason: 'old audit' },
      { id: 'future', scope: 'settlement.finalize', startsAt: '2026-01-02T08:00:00.000Z', endsAt: '2026-01-02T09:00:00.000Z', reason: 'future audit' },
      { id: 'active', scope: 'settlement.finalize', startsAt: '2026-01-01T11:00:00.000Z', endsAt: '2026-01-01T13:00:00.000Z', reason: 'active audit' },
    ];

    expect(() => service.assertNotFrozen('settlement.finalize', windows, now, 'maintainer-1')).toThrow(/active audit/);
    expect(() => service.assertNotFrozen('oracle.poll', windows, now, 'maintainer-1')).not.toThrow();
  });

  it('allows audited emergency bypass actors through active freeze windows', () => {
    const service = new AdminOperationsService();
    const windows: FreezeWindow[] = [{
      id: 'incident',
      scope: '*',
      startsAt: '2026-01-01T11:00:00.000Z',
      endsAt: '2026-01-01T13:00:00.000Z',
      reason: 'incident response',
      emergencyBypassActors: ['incident-commander'],
    }];

    expect(() => service.assertNotFrozen('settlement.finalize', windows, now, 'incident-commander', true)).not.toThrow();
    expect(() => service.assertNotFrozen('settlement.finalize', windows, now, 'maintainer-1', true)).toThrow(/incident response/);
  });

  it('reports normal baseline, volume spikes, repeated failures and suspicious actors', () => {
    const service = new AdminOperationsService();
    const baseline: OperationEvent[] = [
      { actor: 'a', resource: 'bond-1', action: 'read', at: now.toISOString(), success: true, volume: 10 },
    ];
    expect(service.anomalyReport(baseline)).toEqual([]);

    const findings = service.anomalyReport([
      { actor: 'market-maker', resource: 'bond-1', action: 'trade', at: now.toISOString(), success: true, volume: 1200 },
      { actor: 'bad-actor', resource: 'bond-2', action: 'settle', at: now.toISOString(), success: false },
      { actor: 'bad-actor', resource: 'bond-3', action: 'settle', at: now.toISOString(), success: false },
      { actor: 'bad-actor', resource: 'bond-4', action: 'settle', at: now.toISOString(), success: false },
      { actor: 'scanner', resource: 'r1', action: 'read', at: now.toISOString(), success: true },
      { actor: 'scanner', resource: 'r2', action: 'read', at: now.toISOString(), success: true },
      { actor: 'scanner', resource: 'r3', action: 'read', at: now.toISOString(), success: true },
      { actor: 'scanner', resource: 'r4', action: 'read', at: now.toISOString(), success: true },
      { actor: 'scanner', resource: 'r5', action: 'read', at: now.toISOString(), success: true },
    ]);

    expect(findings.map((finding) => finding.signal)).toEqual([
      'volume_spike',
      'repeated_failure',
      'suspicious_actor',
    ]);
  });
});
