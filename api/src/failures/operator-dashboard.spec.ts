import { PartialFailureService } from './partial-failure.service';
import { buildOperatorDashboard } from './operator-dashboard';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

describe('buildOperatorDashboard (#535)', () => {
  let service: PartialFailureService;

  beforeEach(() => {
    service = new PartialFailureService();
  });

  it('lists only live unresolved failures, critical and stale first', () => {
    const info = service.record({ operationType: 'oracle.ingestion', message: 'lag', severity: 'info', now: T0 });
    const freshCritical = service.record({ operationType: 'stellar.settlement', message: 'tx pending', severity: 'critical', now: T0 + 47 * HOUR });
    const staleCritical = service.record({ operationType: 'stellar.settlement', message: 'tx lost', severity: 'critical', now: T0 });
    const resolved = service.record({ operationType: 'bond.issuance', message: 'done', now: T0 });
    service.resolve(resolved.id, 'fixed', T0 + HOUR);

    const board = buildOperatorDashboard(service.list({ includeArchived: true }), { now: T0 + 48 * HOUR });

    expect(board.queue.map((row) => row.id)).toEqual([staleCritical.id, freshCritical.id, info.id]);
    expect(board.totals).toEqual({ unresolved: 3, critical: 2, stale: 2, needsManualRemediation: 0, retrying: 0 });
    expect(board.byOperationType).toEqual({ 'oracle.ingestion': 1, 'stellar.settlement': 2 });
  });

  it('excludes archived failures', () => {
    const failure = service.record({ operationType: 'marketplace.order', message: 'x', now: T0 });
    service.archive(failure.id, 'GOPERATOR', 'duplicate of upstream incident', T0 + HOUR);

    const board = buildOperatorDashboard(service.list({ includeArchived: true }), { now: T0 + 2 * HOUR });
    expect(board.totals.unresolved).toBe(0);
    expect(board.queue).toEqual([]);
  });

  it('stops offering retry once the retry budget is exhausted', () => {
    const failure = service.record({ operationType: 'stellar.settlement', message: 'x', now: T0 });
    service.markRetried(failure.id, T0 + 1);
    service.markRetried(failure.id, T0 + 2);

    const board = buildOperatorDashboard(service.list(), { now: T0 + 3, maxRetries: 2 });
    const [row] = board.queue;
    expect(row.status).toBe('retrying');
    expect(row.retriesRemaining).toBe(0);
    expect(row.needsManualRemediation).toBe(true);
    expect(row.actions).not.toContain('retry');
    expect(board.totals.retrying).toBe(1);
  });

  it('never offers retry for non-retryable failures', () => {
    service.record({ operationType: 'bond.issuance', message: 'x', retryable: false, now: T0 });
    const [row] = buildOperatorDashboard(service.list(), { now: T0 }).queue;
    expect(row.actions).toEqual(['inspect', 'resolve', 'archive']);
    expect(row.needsManualRemediation).toBe(true);
  });

  it('limits queue rows but keeps full totals', () => {
    for (let i = 0; i < 5; i += 1) service.record({ operationType: 'oracle.ingestion', message: `m${i}`, now: T0 + i });
    const board = buildOperatorDashboard(service.list(), { now: T0 + 10, limit: 2 });
    expect(board.queue).toHaveLength(2);
    expect(board.totals.unresolved).toBe(5);
  });

  it('rejects invalid options', () => {
    expect(() => buildOperatorDashboard([], { staleAfterMs: -1 })).toThrow();
    expect(() => buildOperatorDashboard([], { maxRetries: 1.5 })).toThrow();
  });

  it('is exposed through the service for the admin-only controller', () => {
    service.record({ operationType: 'oracle.ingestion', message: 'x', now: T0 });
    expect(service.operatorDashboard({ now: T0 }).totals.unresolved).toBe(1);
  });
});
