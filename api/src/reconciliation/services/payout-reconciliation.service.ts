import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../audit/audit.service';
import { ErrorCode } from '../../common/errors/error-codes';
import { ApiProblemException } from '../../common/errors/problem-exception';
import {
  LedgerPayoutRecord,
  ON_CHAIN_PAYOUT_CLIENT,
  OnChainPayoutClient,
  OnChainPayoutEvent,
  PayoutAdjustmentRecord,
  PayoutDiscrepancy,
  PayoutDiscrepancyType,
  PayoutReconciliationReport,
  ScheduledPayoutItem,
} from '../interfaces/payout-reconciliation.interface';

export interface RunPayoutReconciliationInput {
  bondId: number;
  periodId: string;
  scheduled: ScheduledPayoutItem[];
  ledger: LedgerPayoutRecord[];
  runId?: string;
  now?: Date;
  pageSize?: number;
  maxPages?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  settlingWindowMs?: number;
}

export interface CreateAdjustmentInput {
  runId: string;
  discrepancyId: string;
  payoutId: string | null;
  reason: string;
  amountDeltaMinorUnits: string;
  actor: string;
}

interface RunCheckpoint {
  runId: string;
  bondId: number;
  periodId: string;
  cursor: string | null;
  pagesFetched: number;
  events: OnChainPayoutEvent[];
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_SETTLING_WINDOW_MS = Number(process.env.PAYOUT_SETTLING_WINDOW_MS || 60_000);

@Injectable()
export class PayoutReconciliationService {
  private readonly completedByPeriod = new Map<string, PayoutReconciliationReport>();
  private readonly reportsByRunId = new Map<string, PayoutReconciliationReport>();
  private readonly checkpoints = new Map<string, RunCheckpoint>();
  private readonly adjustments: PayoutAdjustmentRecord[] = [];

  constructor(
    @Inject(ON_CHAIN_PAYOUT_CLIENT) private readonly chainClient: OnChainPayoutClient,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  /**
   * Read-only, idempotent, resumable three-way payout reconciliation for a period.
   * Never moves funds and never mutates ledger/schedule history.
   */
  async reconcilePeriod(input: RunPayoutReconciliationInput): Promise<PayoutReconciliationReport> {
    const periodKey = `${input.bondId}:${input.periodId}`;
    const runId = input.runId || `recon:${periodKey}`;

    const existingCompleted = this.completedByPeriod.get(periodKey) ?? this.reportsByRunId.get(runId);
    if (existingCompleted && existingCompleted.status === 'completed') {
      return { ...existingCompleted, idempotentReplay: true };
    }

    const pageSize = Math.min(Math.max(input.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const maxPages = Math.min(Math.max(input.maxPages ?? DEFAULT_MAX_PAGES, 1), DEFAULT_MAX_PAGES);
    const maxRetries = Math.max(input.maxRetries ?? DEFAULT_MAX_RETRIES, 0);
    const backoffMs = Math.max(input.retryBackoffMs ?? 0, 0);
    const settlingWindowMs = input.settlingWindowMs ?? DEFAULT_SETTLING_WINDOW_MS;
    const now = input.now ?? new Date();

    const checkpoint: RunCheckpoint = this.checkpoints.get(runId) ?? {
      runId,
      bondId: input.bondId,
      periodId: input.periodId,
      cursor: null,
      pagesFetched: 0,
      events: [],
    };

    let fetchError: string | undefined;
    let complete = false;

    while (checkpoint.pagesFetched < maxPages) {
      try {
        const page = await this.fetchWithRetry(
          input.bondId,
          input.periodId,
          checkpoint.cursor,
          pageSize,
          maxRetries,
          backoffMs,
        );
        checkpoint.events.push(...page.events);
        checkpoint.pagesFetched += 1;
        checkpoint.cursor = page.nextCursor;
        if (page.nextCursor === null) {
          complete = true;
          break;
        }
      } catch (err) {
        fetchError = err instanceof Error ? err.message : String(err);
        this.checkpoints.set(runId, checkpoint);
        break;
      }
    }

    if (!complete && !fetchError) {
      fetchError = `Reached bounded page limit (${maxPages} pages)`;
      this.checkpoints.set(runId, checkpoint);
    }

    const report = this.classifyAndBuildReport({
      runId,
      bondId: input.bondId,
      periodId: input.periodId,
      scheduled: input.scheduled,
      ledger: input.ledger,
      onChain: checkpoint.events,
      complete,
      resumeCursor: checkpoint.cursor,
      pagesFetched: checkpoint.pagesFetched,
      error: fetchError,
      now,
      settlingWindowMs,
    });

    this.reportsByRunId.set(runId, report);
    if (report.status === 'completed') {
      this.checkpoints.delete(runId);
      this.completedByPeriod.set(periodKey, report);
    }

    return { ...report };
  }

  getReport(runId: string): PayoutReconciliationReport | null {
    const r = this.reportsByRunId.get(runId);
    return r ? { ...r } : null;
  }

  /**
   * Executable accounting invariant:
   * totalPaidMinorUnits === totalScheduledMinorUnits - totalExceptionDeltaMinorUnits
   */
  verifyPayoutInvariant(report: PayoutReconciliationReport): boolean {
    const scheduled = BigInt(report.totals.totalScheduledMinorUnits);
    const paid = BigInt(report.totals.totalPaidMinorUnits);
    const delta = BigInt(report.totals.totalExceptionDeltaMinorUnits);
    return paid === scheduled - delta;
  }

  /**
   * Record an explicit, audited adjustment for a discrepancy (never mutates history).
   */
  async createAdjustment(input: CreateAdjustmentInput): Promise<PayoutAdjustmentRecord> {
    if (!/^-?\d+$/.test(input.amountDeltaMinorUnits.trim())) {
      throw new ApiProblemException(ErrorCode.VALIDATION_FAILED, {
        detail: 'amountDeltaMinorUnits must be an integer string',
      });
    }
    if (!input.reason.trim()) {
      throw new ApiProblemException(ErrorCode.VALIDATION_FAILED, {
        detail: 'Adjustment reason is required',
      });
    }

    const record: PayoutAdjustmentRecord = {
      adjustmentId: randomUUID(),
      runId: input.runId,
      discrepancyId: input.discrepancyId,
      payoutId: input.payoutId,
      reason: input.reason.trim(),
      amountDeltaMinorUnits: input.amountDeltaMinorUnits.trim(),
      actor: input.actor,
      recordedAt: new Date().toISOString(),
    };
    this.adjustments.push(record);

    if (this.auditService) {
      await this.auditService.record({
        entityType: 'payout_adjustment',
        entityId: record.adjustmentId,
        action: 'create_adjustment',
        actor: input.actor,
        reason: record.reason,
        before: null,
        after: { ...record },
      });
    }

    return { ...record };
  }

  listAdjustments(runId?: string): PayoutAdjustmentRecord[] {
    const list = runId ? this.adjustments.filter((a) => a.runId === runId) : this.adjustments;
    return list.map((a) => ({ ...a }));
  }

  private async fetchWithRetry(
    bondId: number,
    periodId: string,
    cursor: string | null,
    limit: number,
    maxRetries: number,
    backoffMs: number,
  ) {
    let attempt = 0;
    while (true) {
      try {
        return await this.chainClient.fetchPayoutEvents({ bondId, periodId, cursor, limit });
      } catch (err) {
        if (attempt >= maxRetries) {
          throw err;
        }
        attempt++;
        if (backoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
        }
      }
    }
  }

  private classifyAndBuildReport(params: {
    runId: string;
    bondId: number;
    periodId: string;
    scheduled: ScheduledPayoutItem[];
    ledger: LedgerPayoutRecord[];
    onChain: OnChainPayoutEvent[];
    complete: boolean;
    resumeCursor: string | null;
    pagesFetched: number;
    error?: string;
    now: Date;
    settlingWindowMs: number;
  }): PayoutReconciliationReport {
    const ledgerByPayout = new Map<string, LedgerPayoutRecord>();
    for (const l of params.ledger) {
      ledgerByPayout.set(l.payoutId, l);
    }

    const successfulChainByPayout = new Map<string, OnChainPayoutEvent[]>();
    const failedChainByPayout = new Map<string, OnChainPayoutEvent[]>();
    const unmatchedChainEvents: OnChainPayoutEvent[] = [];

    const scheduledIds = new Set(params.scheduled.map((s) => s.payoutId));

    for (const ev of params.onChain) {
      if (ev.payoutId && scheduledIds.has(ev.payoutId)) {
        const bucket = ev.successful ? successfulChainByPayout : failedChainByPayout;
        const list = bucket.get(ev.payoutId) ?? [];
        list.push(ev);
        bucket.set(ev.payoutId, list);
      } else if (ev.successful) {
        unmatchedChainEvents.push(ev);
      }
    }

    const discrepancies: PayoutDiscrepancy[] = [];
    let totalScheduled = 0n;
    let totalLedger = 0n;
    let totalPaid = 0n;
    let matchedCount = 0;
    let pendingSettlementCount = 0;

    for (const item of params.scheduled) {
      const schedAmt = BigInt(item.amountMinorUnits);
      totalScheduled += schedAmt;

      const ledgerRec = ledgerByPayout.get(item.payoutId);
      const ledgerAmt = ledgerRec ? BigInt(ledgerRec.amountMinorUnits) : 0n;
      totalLedger += ledgerAmt;

      const succEvents = successfulChainByPayout.get(item.payoutId) ?? [];
      const failEvents = failedChainByPayout.get(item.payoutId) ?? [];
      const chainPaidAmt = succEvents.reduce((acc, e) => acc + BigInt(e.amountMinorUnits), 0n);
      totalPaid += chainPaidAmt;

      if (!params.complete && succEvents.length === 0) {
        // Never report matched or missing definitively when chain fetch was incomplete
        discrepancies.push({
          id: randomUUID(),
          payoutId: item.payoutId,
          classification: 'pending_settlement',
          scheduledAmount: schedAmt.toString(),
          ledgerAmount: ledgerAmt.toString(),
          onChainAmount: '0',
          destination: item.destination,
          assetCode: item.assetCode,
          assetIssuer: item.assetIssuer,
          txHashes: failEvents.map((e) => e.txHash),
          description: 'On-chain fetch incomplete; cannot confirm settlement status',
        });
        pendingSettlementCount++;
        continue;
      }

      if (succEvents.length > 1) {
        discrepancies.push({
          id: randomUUID(),
          payoutId: item.payoutId,
          classification: 'duplicate',
          scheduledAmount: schedAmt.toString(),
          ledgerAmount: ledgerAmt.toString(),
          onChainAmount: chainPaidAmt.toString(),
          destination: item.destination,
          assetCode: item.assetCode,
          assetIssuer: item.assetIssuer,
          txHashes: succEvents.map((e) => e.txHash),
          description: `Duplicate successful on-chain payments (${succEvents.length}) for payout ${item.payoutId}`,
        });
        continue;
      }

      if (succEvents.length === 0) {
        const ageMs = params.now.getTime() - new Date(item.scheduledAt).getTime();
        const withinSettlingWindow = ageMs >= 0 && ageMs < params.settlingWindowMs;
        const classification: PayoutDiscrepancyType =
          withinSettlingWindow && failEvents.length === 0 ? 'pending_settlement' : 'missing_on_chain';

        if (classification === 'pending_settlement') {
          pendingSettlementCount++;
        }
        discrepancies.push({
          id: randomUUID(),
          payoutId: item.payoutId,
          classification,
          scheduledAmount: schedAmt.toString(),
          ledgerAmount: ledgerAmt.toString(),
          onChainAmount: '0',
          destination: item.destination,
          assetCode: item.assetCode,
          assetIssuer: item.assetIssuer,
          txHashes: failEvents.map((e) => e.txHash),
          description:
            failEvents.length > 0
              ? 'On-chain transaction failed; no successful payment found'
              : classification === 'pending_settlement'
                ? 'Payout is within settling window'
                : 'No successful on-chain payment found after settling window',
        });
        continue;
      }

      const ev = succEvents[0];
      const destOrAssetMismatch =
        ev.destination !== item.destination ||
        ev.assetCode !== item.assetCode ||
        (ev.assetIssuer ?? null) !== (item.assetIssuer ?? null);

      if (destOrAssetMismatch) {
        discrepancies.push({
          id: randomUUID(),
          payoutId: item.payoutId,
          classification: 'wrong_destination_or_asset',
          scheduledAmount: schedAmt.toString(),
          ledgerAmount: ledgerAmt.toString(),
          onChainAmount: chainPaidAmt.toString(),
          destination: ev.destination,
          assetCode: ev.assetCode,
          assetIssuer: ev.assetIssuer,
          txHashes: [ev.txHash],
          description: `Expected ${item.destination} (${item.assetCode}), got ${ev.destination} (${ev.assetCode})`,
        });
        continue;
      }

      if (!ledgerRec) {
        discrepancies.push({
          id: randomUUID(),
          payoutId: item.payoutId,
          classification: 'missing_in_ledger',
          scheduledAmount: schedAmt.toString(),
          ledgerAmount: '0',
          onChainAmount: chainPaidAmt.toString(),
          destination: item.destination,
          assetCode: item.assetCode,
          assetIssuer: item.assetIssuer,
          txHashes: [ev.txHash],
          description: `On-chain payment ${ev.txHash} has no matching internal ledger record`,
        });
        continue;
      }

      if (chainPaidAmt !== schedAmt || ledgerAmt !== schedAmt) {
        discrepancies.push({
          id: randomUUID(),
          payoutId: item.payoutId,
          classification: 'amount_mismatch',
          scheduledAmount: schedAmt.toString(),
          ledgerAmount: ledgerAmt.toString(),
          onChainAmount: chainPaidAmt.toString(),
          destination: item.destination,
          assetCode: item.assetCode,
          assetIssuer: item.assetIssuer,
          txHashes: [ev.txHash],
          description: `Amount mismatch: scheduled=${schedAmt}, ledger=${ledgerAmt}, onChain=${chainPaidAmt}`,
        });
        continue;
      }

      matchedCount++;
    }

    for (const extra of unmatchedChainEvents) {
      const extraAmt = BigInt(extra.amountMinorUnits);
      totalPaid += extraAmt;
      discrepancies.push({
        id: randomUUID(),
        payoutId: extra.payoutId ?? null,
        classification: 'unexpected_extra_payment',
        scheduledAmount: '0',
        ledgerAmount: '0',
        onChainAmount: extraAmt.toString(),
        destination: extra.destination,
        assetCode: extra.assetCode,
        assetIssuer: extra.assetIssuer,
        txHashes: [extra.txHash],
        description: `Unexpected on-chain payment ${extra.txHash} with no scheduled payout`,
      });
    }

    const exceptionDelta = totalScheduled - totalPaid;

    const report: PayoutReconciliationReport = {
      runId: params.runId,
      bondId: params.bondId,
      periodId: params.periodId,
      status: params.complete ? 'completed' : 'partial',
      executedAt: params.now.toISOString(),
      idempotentReplay: false,
      resumeCursor: params.resumeCursor,
      pagesFetched: params.pagesFetched,
      error: params.error,
      totals: {
        totalScheduledMinorUnits: totalScheduled.toString(),
        totalLedgerMinorUnits: totalLedger.toString(),
        totalPaidMinorUnits: totalPaid.toString(),
        totalExceptionDeltaMinorUnits: exceptionDelta.toString(),
        matchedCount,
        discrepancyCount: discrepancies.length,
        pendingSettlementCount,
      },
      discrepancies,
      invariantHolds: false,
    };
    report.invariantHolds = this.verifyPayoutInvariant(report);
    return report;
  }
}
