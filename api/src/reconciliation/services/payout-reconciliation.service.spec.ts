import { AuditService } from '../../audit/audit.service';
import { Permission, Role, RolePermissions } from '../../auth/rbac';
import {
  LedgerPayoutRecord,
  OnChainPayoutEvent,
  ScheduledPayoutItem,
} from '../interfaces/payout-reconciliation.interface';
import { InMemoryOnChainPayoutClient } from './in-memory-payout-chain.client';
import { PayoutReconciliationService } from './payout-reconciliation.service';

describe('PayoutReconciliationService (#621)', () => {
  let chainClient: InMemoryOnChainPayoutClient;
  let auditService: AuditService;
  let service: PayoutReconciliationService;

  const DEST_1 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const DEST_2 = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const ISSUER_1 = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

  const T_SCHEDULED = new Date('2026-01-01T00:00:00.000Z');
  const T_NOW = new Date('2026-01-01T00:10:00.000Z'); // 10 min later (past 60s settling window)

  const makeScheduled = (id: string, dest = DEST_1, amount = '1000000', scheduledAt = T_SCHEDULED): ScheduledPayoutItem => ({
    payoutId: id,
    bondId: 1,
    periodId: '2026-Q1',
    payoutType: 'coupon',
    destination: dest,
    assetCode: 'USDC',
    assetIssuer: ISSUER_1,
    amountMinorUnits: amount,
    scheduledAt: scheduledAt.toISOString(),
  });

  const makeLedger = (id: string, dest = DEST_1, amount = '1000000'): LedgerPayoutRecord => ({
    payoutId: id,
    bondId: 1,
    periodId: '2026-Q1',
    destination: dest,
    assetCode: 'USDC',
    assetIssuer: ISSUER_1,
    amountMinorUnits: amount,
    txHash: `tx-${id}`,
    recordedAt: T_SCHEDULED.toISOString(),
  });

  const makeChainEvent = (
    id: string,
    opts: Partial<OnChainPayoutEvent> = {},
  ): OnChainPayoutEvent => ({
    eventId: `ev-${id}`,
    txHash: `tx-${id}`,
    successful: true,
    bondId: 1,
    periodId: '2026-Q1',
    payoutId: id,
    destination: DEST_1,
    assetCode: 'USDC',
    assetIssuer: ISSUER_1,
    amountMinorUnits: '1000000',
    ledgerClosedAt: T_SCHEDULED.toISOString(),
    ...opts,
  });

  beforeEach(() => {
    chainClient = new InMemoryOnChainPayoutClient();
    auditService = new AuditService();
    service = new PayoutReconciliationService(chainClient, auditService);
  });

  it('reconciles a fully matched period and satisfies the accounting invariant', async () => {
    chainClient.setEvents([makeChainEvent('p1'), makeChainEvent('p2', { destination: DEST_2 })]);

    const report = await service.reconcilePeriod({
      bondId: 1,
      periodId: '2026-Q1',
      scheduled: [makeScheduled('p1'), makeScheduled('p2', DEST_2)],
      ledger: [makeLedger('p1'), makeLedger('p2', DEST_2)],
      now: T_NOW,
    });

    expect(report.status).toBe('completed');
    expect(report.totals.matchedCount).toBe(2);
    expect(report.totals.discrepancyCount).toBe(0);
    expect(report.totals.totalScheduledMinorUnits).toBe('2000000');
    expect(report.totals.totalPaidMinorUnits).toBe('2000000');
    expect(report.totals.totalExceptionDeltaMinorUnits).toBe('0');
    expect(report.invariantHolds).toBe(true);
    expect(service.verifyPayoutInvariant(report)).toBe(true);
  });

  it('flags missing_on_chain after settling window, but pending_settlement within settling window', async () => {
    chainClient.setEvents([]);

    const missingReport = await service.reconcilePeriod({
      bondId: 1,
      periodId: '2026-Q1',
      runId: 'run-missing',
      scheduled: [makeScheduled('p1')],
      ledger: [makeLedger('p1')],
      now: T_NOW,
      settlingWindowMs: 60_000,
    });
    expect(missingReport.discrepancies[0].classification).toBe('missing_on_chain');
    expect(missingReport.invariantHolds).toBe(true);

    const recentReport = await service.reconcilePeriod({
      bondId: 1,
      periodId: '2026-Q2',
      runId: 'run-recent',
      scheduled: [
        {
          ...makeScheduled('p2', DEST_1, '1000000', new Date(T_NOW.getTime() - 10_000)),
          periodId: '2026-Q2',
        },
      ],
      ledger: [{ ...makeLedger('p2'), periodId: '2026-Q2' }],
      now: T_NOW,
      settlingWindowMs: 60_000,
    });
    expect(recentReport.discrepancies[0].classification).toBe('pending_settlement');
    expect(recentReport.totals.pendingSettlementCount).toBe(1);
  });

  it('detects amount mismatch, duplicate payment, wrong asset, and failed transaction', async () => {
    chainClient.setEvents([
      makeChainEvent('p-mismatch', { amountMinorUnits: '900000' }),
      makeChainEvent('p-dup', { eventId: 'ev-d1', txHash: 'tx-d1' }),
      makeChainEvent('p-dup', { eventId: 'ev-d2', txHash: 'tx-d2' }),
      makeChainEvent('p-wrong-asset', { assetCode: 'XLM', assetIssuer: null }),
      makeChainEvent('p-failed', { successful: false }),
    ]);

    const report = await service.reconcilePeriod({
      bondId: 1,
      periodId: '2026-Q1',
      scheduled: [
        makeScheduled('p-mismatch'),
        makeScheduled('p-dup'),
        makeScheduled('p-wrong-asset'),
        makeScheduled('p-failed'),
      ],
      ledger: [
        makeLedger('p-mismatch'),
        makeLedger('p-dup'),
        makeLedger('p-wrong-asset'),
        makeLedger('p-failed'),
      ],
      now: T_NOW,
    });

    const classes = report.discrepancies.map((d) => d.classification);
    expect(classes).toEqual([
      'amount_mismatch',
      'duplicate',
      'wrong_destination_or_asset',
      'missing_on_chain',
    ]);
    expect(report.invariantHolds).toBe(true);
  });

  it('recovers from transient fetch failures via retry and resumes partial pages without reporting matched', async () => {
    chainClient.setEvents([makeChainEvent('p1'), makeChainEvent('p2')]);

    // Exhaust retries on page 2 -> partial status, never reports matched
    chainClient.injectFailures(2, 1);
    const partial = await service.reconcilePeriod({
      bondId: 1,
      periodId: '2026-Q1',
      runId: 'resumable-run',
      scheduled: [makeScheduled('p1'), makeScheduled('p2')],
      ledger: [makeLedger('p1'), makeLedger('p2')],
      pageSize: 1,
      maxRetries: 0,
      now: T_NOW,
    });

    expect(partial.status).toBe('partial');
    expect(partial.pagesFetched).toBe(1);
    expect(partial.totals.matchedCount).toBe(1);
    expect(partial.discrepancies.some((d) => d.classification === 'pending_settlement')).toBe(true);

    // Clear failure and resume same runId -> fetches remaining page and completes
    chainClient.injectFailures(0);
    const resumed = await service.reconcilePeriod({
      bondId: 1,
      periodId: '2026-Q1',
      runId: 'resumable-run',
      scheduled: [makeScheduled('p1'), makeScheduled('p2')],
      ledger: [makeLedger('p1'), makeLedger('p2')],
      pageSize: 1,
      maxRetries: 1,
      now: T_NOW,
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.pagesFetched).toBe(2);
    expect(resumed.totals.matchedCount).toBe(2);
    expect(resumed.totals.discrepancyCount).toBe(0);
  });

  it('returns the stored report idempotently on re-run and supports audited adjustments', async () => {
    chainClient.setEvents([makeChainEvent('p1')]);

    const r1 = await service.reconcilePeriod({
      bondId: 1,
      periodId: '2026-Q1',
      scheduled: [makeScheduled('p1')],
      ledger: [makeLedger('p1')],
      now: T_NOW,
    });
    const r2 = await service.reconcilePeriod({
      bondId: 1,
      periodId: '2026-Q1',
      scheduled: [makeScheduled('p1')],
      ledger: [makeLedger('p1')],
      now: T_NOW,
    });

    expect(r1.idempotentReplay).toBe(false);
    expect(r2.idempotentReplay).toBe(true);
    expect(r2.runId).toBe(r1.runId);

    const adj = await service.createAdjustment({
      runId: r1.runId,
      discrepancyId: 'disc-1',
      payoutId: 'p1',
      reason: 'Manual treasury credit reconciliation',
      amountDeltaMinorUnits: '-1000',
      actor: ISSUER_1,
    });
    expect(adj.adjustmentId).toBeDefined();
    expect(auditService.getEntityHistory('payout_adjustment', adj.adjustmentId)).toHaveLength(1);
  });

  it('restricts RECONCILE_PAYOUTS permission to SETTLEMENT_MANAGER and MAINTAINER', () => {
    expect(RolePermissions[Role.SETTLEMENT_MANAGER]).toContain(Permission.RECONCILE_PAYOUTS);
    expect(RolePermissions[Role.MAINTAINER]).toContain(Permission.RECONCILE_PAYOUTS);
    expect(RolePermissions[Role.INVESTOR]).not.toContain(Permission.RECONCILE_PAYOUTS);
    expect(RolePermissions[Role.ISSUER]).not.toContain(Permission.RECONCILE_PAYOUTS);
  });
});
