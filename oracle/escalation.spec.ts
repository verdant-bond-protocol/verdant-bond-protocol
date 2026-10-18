import {
  EscalationQueue,
  buildDisagreementDashboard,
  buildDashboardFromReports,
  isEscalatable,
  escalationTicketId,
  ESCALATION_ROUTE,
} from './escalation';
import { CrossSourceAssessment } from './anomaly';

describe('Cross-oracle disagreement dashboard & operator escalation (#443)', () => {
  const report = (
    sourceId: string,
    carbon: number,
    methodology = 'REMOTE-SENSING',
  ) => ({
    projectId: 'VCS-1',
    periodStart: 0,
    periodEnd: 100,
    sourceId,
    methodology,
    carbon,
  });

  function assessment(overrides: Partial<CrossSourceAssessment>): CrossSourceAssessment {
    return {
      projectId: 'VCS-1',
      periodKey: '0-100',
      kind: 'conflicting_sources',
      severity: 'critical',
      median: 100,
      deviations: [],
      tolerance: 0.25,
      reason: 'conflict',
      ...overrides,
    };
  }

  it('summarises agreement without escalating', () => {
    const dashboard = buildDashboardFromReports([
      report('a', 100),
      report('b', 105),
      report('c', 98),
    ]);
    expect(dashboard.summary.total).toBe(1);
    expect(dashboard.summary.byKind.normal).toBe(1);
    expect(dashboard.summary.escalated).toBe(0);
    expect(isEscalatable(dashboard.entries[0])).toBe(false);
  });

  it('does not escalate a single-source period', () => {
    const dashboard = buildDashboardFromReports([report('a', 100)]);
    expect(dashboard.summary.byKind.missing_source).toBe(1);
    expect(dashboard.summary.escalated).toBe(0);
  });

  it('flags a critical conflict and routes it to on-call', () => {
    const dashboard = buildDisagreementDashboard([
      {
        projectId: 'VCS-1',
        periodKey: '0-100',
        values: [
          { sourceId: 'a', methodology: 'REMOTE-SENSING', carbon: 100 },
          { sourceId: 'b', methodology: 'REMOTE-SENSING', carbon: 400 },
        ],
      },
    ]);
    expect(dashboard.summary.bySeverity.critical).toBe(1);
    expect(dashboard.summary.escalated).toBe(1);

    const queue = new EscalationQueue();
    const created = queue.sync(dashboard.entries, 1000);
    expect(created).toHaveLength(1);
    expect(created[0].route).toBe(ESCALATION_ROUTE.critical);
    expect(created[0].status).toBe('open');
    expect(created[0].dueAtMs).toBe(1000 + 60 * 60 * 1000);
  });

  it('deduplicates tickets across repeated scans', () => {
    const queue = new EscalationQueue();
    const entry = assessment({});
    expect(queue.sync([entry], 0)).toHaveLength(1);
    expect(queue.sync([entry], 5000)).toHaveLength(0);
    expect(queue.list()).toHaveLength(1);
  });

  it('keeps normal and info outliers off the escalation queue', () => {
    const queue = new EscalationQueue();
    queue.sync(
      [
        assessment({ kind: 'normal', severity: 'info' }),
        assessment({ kind: 'outlier', severity: 'info' }),
        assessment({ kind: 'missing_source', severity: 'info' }),
      ],
      0,
    );
    expect(queue.list()).toHaveLength(0);
  });

  it('drives the assignment, acknowledgement, and resolution lifecycle', () => {
    const queue = new EscalationQueue();
    const entry = assessment({});
    const [ticket] = queue.sync([entry], 0);

    queue.assign(ticket.id, 'alice');
    expect(queue.get(ticket.id)?.assignee).toBe('alice');

    queue.acknowledge(ticket.id);
    expect(queue.get(ticket.id)?.status).toBe('acknowledged');
    expect(queue.get(ticket.id)?.acknowledgedAtMs).toBeDefined();

    queue.resolve(ticket.id, 'false reading from broken sensor');
    const resolved = queue.get(ticket.id)!;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionNote).toBe('false reading from broken sensor');
    expect(queue.open()).toHaveLength(0);
  });

  it('requires a resolution note and refuses to touch resolved tickets', () => {
    const queue = new EscalationQueue();
    const [ticket] = queue.sync([assessment({})], 0);
    expect(() => queue.resolve(ticket.id, '   ')).toThrow(/resolution note/);
    queue.resolve(ticket.id, 'handled');
    expect(() => queue.assign(ticket.id, 'bob')).toThrow(/resolved/);
    expect(() => queue.acknowledge(ticket.id)).toThrow(/resolved/);
  });

  it('reports SLA-overdue tickets', () => {
    const queue = new EscalationQueue();
    queue.sync([assessment({ severity: 'warning' })], 0);
    expect(queue.overdue(1000)).toHaveLength(0);
    expect(queue.overdue(25 * 60 * 60 * 1000)).toHaveLength(1);
  });

  it('builds stable ticket ids from project, period, and kind', () => {
    const id = escalationTicketId(assessment({}));
    expect(id).toBe('VCS-1::0-100::conflicting_sources');
  });

  it('tracks counts by kind and severity in the dashboard', () => {
    const dashboard = buildDisagreementDashboard([
      {
        projectId: 'VCS-1',
        periodKey: '0-100',
        values: [
          { sourceId: 'a', carbon: 100 },
          { sourceId: 'b', carbon: 400 },
        ],
      },
      {
        projectId: 'VCS-2',
        periodKey: '0-100',
        values: [
          { sourceId: 'a', carbon: 100 },
          { sourceId: 'b', carbon: 101 },
        ],
      },
    ]);
    expect(dashboard.summary.total).toBe(2);
    expect(dashboard.summary.byKind.conflicting_sources).toBe(1);
    expect(dashboard.summary.byKind.normal).toBe(1);
    expect(dashboard.summary.escalated).toBe(1);
  });
});
