import { Test, TestingModule } from '@nestjs/testing';
import { PartialFailureService } from './partial-failure.service';
import { DEFAULT_STALE_AFTER_MS } from './partial-failure.interface';

const NOW = Date.parse('2026-06-02T00:00:00Z');
const DAY = DEFAULT_STALE_AFTER_MS;

describe('PartialFailureService (#266)', () => {
  let service: PartialFailureService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PartialFailureService],
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

    it('manually ignored failures stay out of the board but remain queryable', () => {
      const failure = record();

      service.ignore(failure.id, 'duplicate of tx_abc124', NOW + 1);
      const board = service.dashboard({ now: NOW + 1 });

      expect(board.groups).toHaveLength(0);
      expect(service.get(failure.id).status).toBe('ignored');
      expect(service.get(failure.id).ignoredNote).toBe('duplicate of tx_abc124');
    });

    it('lists retryable failures only when filtered', () => {
      record({ retryable: false });
      record({ operationType: 'oracle.ingestion' });

      const retryable = service.list({ retryable: true }, NOW);
      expect(retryable).toHaveLength(1);
      expect(retryable[0].operationType).toBe('oracle.ingestion');
    });
  });
});
