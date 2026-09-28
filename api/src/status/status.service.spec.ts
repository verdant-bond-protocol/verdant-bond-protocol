import { StatusService } from './status.service';
import { OracleIncidentSeverity, OracleIncidentStatus, OracleIncidentSubjectType } from '../oracle/interfaces/oracle-incident.interface';

function incident(overrides: Partial<import('../oracle/interfaces/oracle-incident.interface').OracleIncident> = {}) {
  return {
    id: 'incident-1',
    dedupeKey: 'dedupe-1',
    subjectType: OracleIncidentSubjectType.Project,
    subjectId: 'INTERNAL-PROJECT-42', // must never appear in the public feed
    status: OracleIncidentStatus.Active,
    severity: OracleIncidentSeverity.Critical,
    occurrenceCount: 3,
    firstDetectedAt: '2026-01-01T00:00:00.000Z',
    lastDetectedAt: '2026-01-01T01:00:00.000Z',
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: 'internal note: escalated to ops wallet GABC...', // must never appear either
    details: { projectIds: ['INTERNAL-PROJECT-42'] },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T01:00:00.000Z',
    ...overrides,
  };
}

function makeService(opts: { redisHealthy: boolean; incidents: ReturnType<typeof incident>[] }) {
  const redis = { isHealthy: () => opts.redisHealthy } as any;
  const oracleIncidents = {
    findMany: jest.fn(async (_page: number, _limit: number, status: OracleIncidentStatus) => ({
      data: opts.incidents.filter((i) => i.status === status),
      meta: { page: 1, limit: 50, total: 0, totalPages: 1 },
    })),
  } as any;
  return new StatusService(redis, oracleIncidents);
}

describe('StatusService.getPublicStatus', () => {
  it('healthy: reports overall healthy with an operational cache and no incidents', async () => {
    const service = makeService({ redisHealthy: true, incidents: [] });
    const report = await service.getPublicStatus(Date.parse('2026-01-02T00:00:00.000Z'));

    expect(report.schemaVersion).toBe(1);
    expect(report.overallStatus).toBe('healthy');
    expect(report.components).toEqual([{ name: 'cache', status: 'operational', description: expect.any(String) }]);
    expect(report.incidents).toEqual([]);
  });

  it('degraded: an unhealthy component without any incident reports overall degraded', async () => {
    const service = makeService({ redisHealthy: false, incidents: [] });
    const report = await service.getPublicStatus(Date.parse('2026-01-02T00:00:00.000Z'));

    expect(report.overallStatus).toBe('degraded');
    expect(report.components.find((c) => c.name === 'cache')?.status).toBe('down');
  });

  it('incident: an active oracle incident reports overall incident and a public-safe entry', async () => {
    const service = makeService({ redisHealthy: true, incidents: [incident()] });
    const report = await service.getPublicStatus(Date.parse('2026-01-02T00:00:00.000Z'));

    expect(report.overallStatus).toBe('incident');
    expect(report.incidents).toHaveLength(1);
    expect(report.incidents[0]).toMatchObject({ id: 'incident-1', status: 'investigating' });
  });

  it('maps an acknowledged incident to "monitoring" and a resolved one is excluded from the active feed', async () => {
    const service = makeService({
      redisHealthy: true,
      incidents: [
        incident({ id: 'ack-1', status: OracleIncidentStatus.Acknowledged }),
        incident({ id: 'resolved-1', status: OracleIncidentStatus.Resolved }),
      ],
    });
    const report = await service.getPublicStatus(Date.parse('2026-01-02T00:00:00.000Z'));

    expect(report.incidents).toHaveLength(1);
    expect(report.incidents[0]).toMatchObject({ id: 'ack-1', status: 'monitoring' });
    expect(report.overallStatus).toBe('incident');
  });

  it('maintenance: an in-progress window reports overall maintenance when nothing else is wrong', async () => {
    const service = makeService({ redisHealthy: true, incidents: [] });
    const now = Date.parse('2026-01-02T00:00:00.000Z');
    const window = service.scheduleMaintenance(
      'Database migration',
      new Date(now - 1000).toISOString(),
      new Date(now + 60 * 60 * 1000).toISOString(),
      'GADMIN000000000000000000000000000000000000000000000000',
      now,
    );

    const report = await service.getPublicStatus(now);

    expect(report.overallStatus).toBe('maintenance');
    expect(report.maintenanceWindows).toEqual([
      { id: window.id, title: 'Database migration', status: 'in_progress', startsAt: window.startsAt, endsAt: window.endsAt },
    ]);
  });

  it('a scheduled (future) or completed (past) window does not by itself change overall status, and a cancelled one is hidden', async () => {
    const service = makeService({ redisHealthy: true, incidents: [] });
    const now = Date.parse('2026-01-02T00:00:00.000Z');
    const future = service.scheduleMaintenance('Future work', new Date(now + DAY(1)).toISOString(), new Date(now + DAY(2)).toISOString(), 'GADMIN0000000000000000000000000000000000000000000000000', now);
    const past = service.scheduleMaintenance('Past work', new Date(now - DAY(2)).toISOString(), new Date(now - DAY(1)).toISOString(), 'GADMIN0000000000000000000000000000000000000000000000000', now);
    const cancelled = service.scheduleMaintenance('Cancelled work', new Date(now - DAY(1)).toISOString(), new Date(now + DAY(1)).toISOString(), 'GADMIN0000000000000000000000000000000000000000000000000', now);
    service.cancelMaintenance(cancelled.id, now);

    const report = await service.getPublicStatus(now);

    expect(report.overallStatus).toBe('healthy');
    const statuses = report.maintenanceWindows.map((w) => ({ id: w.id, status: w.status }));
    expect(statuses).toEqual(
      expect.arrayContaining([
        { id: future.id, status: 'scheduled' },
        { id: past.id, status: 'completed' },
      ]),
    );
    expect(statuses.find((w) => w.id === cancelled.id)).toBeUndefined();
  });

  it('private-data filtering: no internal diagnostics leak into the public incident shape', async () => {
    const service = makeService({ redisHealthy: true, incidents: [incident()] });
    const report = await service.getPublicStatus(Date.parse('2026-01-02T00:00:00.000Z'));

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('INTERNAL-PROJECT-42');
    expect(serialized).not.toContain('escalated to ops wallet');
    expect(Object.keys(report.incidents[0]).sort()).toEqual(['id', 'startedAt', 'status', 'title', 'updatedAt']);
  });

  it('private-data filtering: the component list never includes a contract address or raw error text', async () => {
    const oracleIncidents = { findMany: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 10.0.4.12:5432 secret-detail')) } as any;
    const service = new StatusService({ isHealthy: () => true } as any, oracleIncidents);

    const report = await service.getPublicStatus(Date.parse('2026-01-02T00:00:00.000Z'));

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('10.0.4.12');
    expect(serialized).not.toContain('secret-detail');
    expect(report.components.find((c) => c.name === 'oracle-monitoring')?.status).toBe('down');
  });
});

function DAY(n: number): number {
  return n * 24 * 60 * 60 * 1000;
}
