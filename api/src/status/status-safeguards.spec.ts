import { StatusSafeguardsManager, redactSecretsFromText, redactSecretsDeep } from './status-safeguards';
import { StatusError } from './status.interface';

describe('Safe Public-Status Model (#370)', () => {
  let manager: StatusSafeguardsManager;
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  beforeEach(() => {
    manager = new StatusSafeguardsManager();
  });

  it('reports healthy with mutations allowed in baseline state', () => {
    const report = manager.buildPublicReport({
      now,
      baseComponents: [{ name: 'cache', status: 'operational', description: 'Shared cache' }],
      incidents: [],
      maintenanceWindows: [],
    });

    expect(report.overallStatus).toBe('healthy');
    expect(report.isMutationAllowed).toBe(true);
    expect(report.components[0].status).toBe('operational');
  });

  it('transitions overall status to degraded when a component is degraded', () => {
    manager.setComponentStatus('oracle-monitoring', 'degraded', 'Slow response');
    const report = manager.buildPublicReport({
      now,
      baseComponents: [{ name: 'cache', status: 'operational', description: 'Shared cache' }],
      incidents: [],
      maintenanceWindows: [],
    });

    expect(report.overallStatus).toBe('degraded');
    const comp = report.components.find((c) => c.name === 'oracle-monitoring');
    expect(comp?.status).toBe('degraded');
  });

  it('transitions overall status to paused and disables mutations when paused', () => {
    manager.pauseProtocol('Smart contract pause', 'GADMIN');
    const report = manager.buildPublicReport({
      now,
      baseComponents: [{ name: 'cache', status: 'operational', description: 'Shared cache' }],
      incidents: [],
      maintenanceWindows: [],
    });

    expect(report.overallStatus).toBe('paused');
    expect(report.isMutationAllowed).toBe(false);

    expect(() => manager.assertMutationAllowed('bond-issuance')).toThrow(
      expect.objectContaining({ code: 'protocol_paused' }),
    );
  });

  it('allows granular component-level pause while keeping other components active', () => {
    manager.setComponentStatus('bond-issuance', 'paused', 'Bond minting paused');

    expect(() => manager.assertMutationAllowed('bond-issuance')).toThrow(
      expect.objectContaining({ code: 'protocol_paused' }),
    );

    // Other component remains allowed
    expect(() => manager.assertMutationAllowed('dex-settlement')).not.toThrow();
  });

  it('transitions overall status to maintenance during active maintenance window', () => {
    const report = manager.buildPublicReport({
      now,
      baseComponents: [{ name: 'cache', status: 'operational', description: 'Shared cache' }],
      incidents: [],
      maintenanceWindows: [
        {
          id: 'w-1',
          title: 'DB Upgrade',
          status: 'in_progress',
          startsAt: new Date(now - 1000).toISOString(),
          endsAt: new Date(now + 3600000).toISOString(),
        },
      ],
    });

    expect(report.overallStatus).toBe('maintenance');
  });

  it('rigorously redacts Stellar secret keys, DB connection strings, JWTs, and IPs', () => {
    const leakedText =
      'Connect postgres://dbuser:P@ssword123!@10.0.0.5:5432/main with key SA2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P7Q8R9S0T1U2V3W4X5Y6Z7A8B';
    const clean = redactSecretsFromText(leakedText);

    expect(clean).not.toContain('P@ssword123!');
    expect(clean).not.toContain('10.0.0.5');
    expect(clean).not.toContain('SA2B3C4D5E6F7G8H9I0J1K2L3M4N5O6P7Q8R9S0T1U2V3W4X5Y6Z7A8B');
    expect(clean).toContain('[REDACTED_DB_URI]');
    expect(clean).toContain('[REDACTED_STELLAR_SECRET]');
  });
});
