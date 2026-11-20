import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from '../notifications/notifications.service';
import { PartialFailureService } from './partial-failure.service';
import { DEFAULT_STALE_AFTER_MS } from './partial-failure.interface';

const NOW = Date.parse('2026-06-02T00:00:00Z');
const DAY = DEFAULT_STALE_AFTER_MS;

describe('PartialFailureService (#266)', () => {
  let service: PartialFailureService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PartialFailureService, NotificationsService],
    }).compile();
    service = module.get<PartialFailureService>(PartialFailureService);
  });

  const record = (overrides: Record<string, unknown> = {}, at = NOW) =>
    service.record(
      {
        operationType: 'stellar.settlement',
        externalRef: 'tx_abc123',
        message: 'settlement submitted but not confirmed',
        ...overrides,
        now: at,
      } as never,
    );

  describe('recording & metadata hygiene', () => {
    it('scrubs secret-shaped metadata keys before storing', () => {
      const failure = record({
        metadata: {
          walletAddress: 'GUSER',
          passphrase: 'hunter2',
          privateKey: 'SABC',
          apiToken: 'tok_123',
          nested: { seedPhrase: 'words words words', ledger: 4_000 },
        },
      });

      expect(failure.metadata).toEqual({
        walletAddress: 'GUSER',
        passphrase: '[redacted]',
        privateKey: '[redacted]',
        apiToken: '[redacted]',
        nested: { seedPhrase: '[redacted]', ledger: 4_000 },
      });
    });

    it('records an open, retryable failure with a default warning severity', () => {
      const failure = record();

      expect(failure.status).toBe('open');
      expect(failure.retryable).toBe(true);
      expect(failure.severity).toBe('warning');
    });
  });

  describe('dashboard grouping (issue #266)', () => {
    it('groups failures by operation type with status, severity and retryability counts', () => {
      record();
      record({ externalRef: 'tx_def456', severity: 'critical' });
      record({
        operationType: 'oracle.ingestion',
        message: 'report ingested but not projected',
        retryable: false,
      });

      const board = service.dashboard({ now: NOW });

      expect(board.unresolved).toBe(3);
      expect(board.groups).toHaveLength(2);
      const settlement = board.groups.find((g) => g.operationType === 'stellar.settlement');
      expect(settlement?.total).toBe(2);
      expect(settlement?.bySeverity).toEqual({ info: 0, warning: 1, critical: 1 });
      expect(settlement?.retryable).toBe(2);
      const oracle = board.groups.find((g) => g.operationType === 'oracle.ingestion');
      expect(oracle?.retryable).toBe(0);
    });

    it('includes age, staleness and retry/inspect/remediation links without secrets', () => {
      const failure = record({
        metadata: { privateKey: 'SSECRET' },
      });

      const board = service.dashboard({ now: NOW });
      const row = board.groups[0].failures[0];

      expect(row.ageMs).toBe(0);
      expect(row.stale).toBe(false);
      expect(row.links.inspect).toBe(`GET /api/v1/operations/failures/${failure.id}`);
      expect(row.links.retry).toBe(`POST /api/v1/operations/failures/${failure.id}/retry`);
      expect(row.links.remediationDoc).toContain('runbook');
      expect(JSON.stringify(row)).not.toContain('SSECRET');
    });

    it('marks open failures stale after the threshold but not resolved ones', () => {
      const stale = record({}, NOW - DAY - 1);
      const freshResolved = record({}, NOW - DAY - 1);
      service.resolve(freshResolved.id, 'confirmed on-chain', NOW - 1);

      const board = service.dashboard({ now: NOW });

      const staleRow = board.groups[0].failures.find((f) => f.id === stale.id);
      expect(staleRow?.stale).toBe(true);
      const resolvedRow = board.groups[0].failures.find((f) => f.id === freshResolved.id);
      expect(resolvedRow?.stale).toBe(false);
      expect(board.groups[0].byStatus.resolved).toBe(1);
    });
  });

  describe('lifecycle actions', () => {
    it('tracks retries through the retrying status and counter', () => {
      const failure = record();
      service.markRetried(failure.id, NOW + 1);
      service.markRetried(failure.id, NOW + 2);

      const after = service.get(failure.id);
      expect(after.status).toBe('retrying');
      expect(after.retryCount).toBe(2);
      expect(after.lastFailureAt).toBe(new Date(NOW + 2).toISOString());
    });

    it('resolves a failure and drops it from unresolved counts', () => {
      const failure = record();

      service.resolve(failure.id, 'manually settled', NOW + 1);
      const board = service.dashboard({ now: NOW + 1 });

      expect(board.unresolved).toBe(0);
      expect(service.get(failure.id).resolvedNote).toBe('manually settled');
    });

    it('archives a failure with an actor and reason, keeping it out of the board but queryable', () => {
      const failure = record();

      service.archive(failure.id, 'GADMIN', 'duplicate of tx_abc124', NOW + 1);
      const board = service.dashboard({ now: NOW + 1 });

      expect(board.groups[0].failures).toHaveLength(0);
      expect(board.archived).toBe(1);
      expect(board.groups[0].archived).toBe(1);
      const archived = service.get(failure.id);
      expect(archived.lifecycle.state).toBe('archived');
      expect(archived.lifecycle.archivedBy).toBe('GADMIN');
      expect(archived.lifecycle.archiveReason).toBe('duplicate of tx_abc124');
      // The work status is untouched: archiving hides a record, it does not
      // resolve it.
      expect(archived.status).toBe('open');
      expect(service.list({ includeArchived: true }, NOW + 1)).toHaveLength(1);
      expect(service.list({}, NOW + 1)).toHaveLength(0);
    });

    it('surfaces archived rows with their attribution when the board opts in', () => {
      const live = record({ externalRef: 'tx_live' });
      const archived = record({ externalRef: 'tx_archived' });
      service.archive(archived.id, 'GADMIN', 'duplicate of tx_live', NOW + 1);

      const board = service.dashboard({ now: NOW + 2, filter: { includeArchived: true } });
      const rows = board.groups[0].failures;

      expect(rows.map((r) => r.id)).toEqual([live.id, archived.id]);
      // The archived row is labelled, so it cannot be mistaken for live work.
      expect(rows[1].lifecycle.state).toBe('archived');
      expect(rows[1].lifecycle.archivedBy).toBe('GADMIN');
      expect(rows[1].lifecycle.archiveReason).toBe('duplicate of tx_live');
      expect(rows[1].stale).toBe(false);
      // Counters describe live work only; the archived row is not double counted.
      expect(board.unresolved).toBe(1);
      expect(board.groups[0].byStatus).toEqual({ open: 1, retrying: 0, resolved: 0 });
      expect(board.archived).toBe(1);
    });

    it('refuses to archive without a reason, and refuses to archive twice', () => {
      const failure = record();

      expect(() => service.archive(failure.id, 'GADMIN', '   ', NOW + 1)).toThrow(
        expect.objectContaining({ code: 'missing_reason' }),
      );

      service.archive(failure.id, 'GADMIN', 'duplicate of tx_abc124', NOW + 1);
      expect(() => service.archive(failure.id, 'GOTHER', 'again', NOW + 2)).toThrow(
        expect.objectContaining({ code: 'already_archived' }),
      );
      // The second attempt did not overwrite the original attribution.
      expect(service.get(failure.id).lifecycle.archivedBy).toBe('GADMIN');
    });

    it('restores an archived failure and keeps the archive in its history', () => {      const failure = record();
      service.archive(failure.id, 'GADMIN', 'duplicate of tx_abc124', NOW + 1);

      service.restore(failure.id, 'GADMIN', NOW + 2);
      const board = service.dashboard({ now: NOW + 2 });
      const restored = service.get(failure.id);

      expect(restored.lifecycle.state).toBe('active');
      expect(restored.lifecycle.restoredBy).toBe('GADMIN');
      expect(restored.lifecycle.history.map((e) => e.action)).toEqual(['archive', 'restore']);
      expect(board.groups[0].failures.map((f) => f.id)).toEqual([failure.id]);
      expect(board.archived).toBe(0);
    });

    it('refuses to restore a record that was never archived', () => {
      const failure = record();
      expect(() => service.restore(failure.id, 'GADMIN', NOW + 1)).toThrow(
        expect.objectContaining({ code: 'not_archived' }),
      );
    });

    it('refuses to resolve, retry, or re-archive-by-work an archived failure', () => {
      const failure = record();
      service.archive(failure.id, 'GADMIN', 'duplicate', NOW + 1);

      expect(() => service.resolve(failure.id, 'done', NOW + 2)).toThrow(/archived/);
      expect(() => service.markRetried(failure.id, NOW + 2)).toThrow(/archived/);
      expect(service.get(failure.id).status).toBe('open');
    });

    it('lists retryable failures only when filtered', () => {
      record({ retryable: false });
      record({ operationType: 'oracle.ingestion' });

      const retryable = service.list({ retryable: true }, NOW);
      expect(retryable).toHaveLength(1);
      expect(retryable[0].operationType).toBe('oracle.ingestion');
    });
  });

  describe('maintainer queue filtering (#305)', () => {
    it('filters by severity, free text, retry count, external reference and stale state', () => {
      const old = record({
        externalRef: 'tx_old',
        severity: 'critical',
        metadata: { dependsOn: ['bond:7'], note: 'coupon payout' },
      }, NOW - DAY - 1);
      service.markRetried(old.id, NOW - DAY);
      record({
        externalRef: 'tx_new',
        severity: 'warning',
        metadata: { note: 'oracle projection' },
      });

      const filtered = service.list({
        severity: 'critical',
        text: 'coupon',
        minRetryCount: 1,
        externalRef: 'tx_old',
        staleOnly: true,
      }, NOW);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe(old.id);
    });

    it('applies filters to the grouped dashboard', () => {
      record({ operationType: 'stellar.settlement' });
      record({ operationType: 'oracle.ingestion' });

      const board = service.dashboard({
        now: NOW,
        filter: { operationType: 'oracle.ingestion' },
      });

      expect(board.groups).toHaveLength(1);
      expect(board.groups[0].operationType).toBe('oracle.ingestion');
    });
  });

  describe('dependency graph impact analysis (#306)', () => {
    it('builds an operation, failure and resource graph from failure metadata', () => {
      const failure = record({
        operationType: 'coupon.distribution',
        externalRef: 'tx_coupon',
        metadata: { dependsOn: ['bond:42', 'oracle:report-9'] },
      });

      const graph = service.dependencyGraph('bond:42', NOW);

      expect(graph.impactedFailures).toEqual([failure.id]);
      expect(graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
        `failure:${failure.id}`,
        'operation:coupon.distribution',
        'resource:bond:42',
        'resource:oracle:report-9',
        'external:tx_coupon',
      ]));
      expect(graph.edges).toEqual(expect.arrayContaining([
        { from: `failure:${failure.id}`, to: 'resource:bond:42', relation: 'depends_on' },
      ]));
    });
  });

  describe('rejected operation explanations (#309)', () => {
    it('returns a user-facing explanation and next actions for known rejection codes', () => {
      const explanation = service.explainRejectedOperation('insufficient_balance', {
        supportReference: 'support-123',
      });

      expect(explanation.title).toBe('Insufficient balance');
      expect(explanation.userMessage).not.toMatch(/exception|stack|internal/i);
      expect(explanation.nextActions.length).toBeGreaterThan(1);
      expect(explanation.retryable).toBe(true);
      expect(explanation.supportReference).toBe('support-123');
    });

    it('falls back to a safe generic explanation for unknown rejection codes', () => {
      const explanation = service.explainRejectedOperation('contract_error_7');

      expect(explanation.code).toBe('contract_error_7');
      expect(explanation.retryable).toBe(false);
      expect(explanation.userMessage).toContain('rejected');
    });
  });

  describe('historical trend export (#310)', () => {
    it('exports bucketed operational metrics as JSON and CSV', () => {
      const first = record({ severity: 'critical' }, NOW);
      const second = record({ severity: 'info', retryable: false }, NOW + DAY + 1);
      service.resolve(second.id, 'done', NOW + DAY + 2);

      const json = service.trendExport({ bucketMs: DAY, now: NOW + DAY + 3 });
      expect(json.buckets).toHaveLength(2);
      expect(json.buckets[0].total).toBe(1);
      expect(json.buckets[0].bySeverity.critical).toBe(1);
      expect(json.buckets[1].byStatus.resolved).toBe(1);

      const csv = service.trendExport({ bucketMs: DAY, format: 'csv', now: NOW + DAY + 3 });
      expect(csv.csv).toContain('bucketStart,bucketEnd,total');
      expect(csv.csv).toContain(first.createdAt.slice(0, 10));
    });

    it('reports archived failures as their own column so the export matches the board', () => {
      const live = record({ externalRef: 'tx_live' }, NOW);
      const archived = record({ externalRef: 'tx_archived' }, NOW);
      service.archive(archived.id, 'GADMIN', 'duplicate of tx_live', NOW + 1);

      const bucket = service.trendExport({ bucketMs: DAY, now: NOW + 2 }).buckets[0];
      const board = service.dashboard({ now: NOW + 2 });

      // The export counts the archived record; the board reports it without
      // rendering it as a row. Neither view silently drops it.
      expect(bucket.total).toBe(2);
      expect(bucket.archived).toBe(1);
      expect(bucket.unresolved).toBe(1);
      expect(bucket.byStatus).toEqual({ open: 1, retrying: 0, resolved: 0 });
      expect(board.archived).toBe(bucket.archived);
      expect(board.unresolved).toBe(bucket.unresolved);
      expect(board.groups[0].failures.map((f) => f.id)).toEqual([live.id]);
    });
  });
});
