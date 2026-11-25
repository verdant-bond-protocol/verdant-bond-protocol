export type PayoutType = 'coupon' | 'principal';

export type PayoutDiscrepancyType =
  | 'matched'
  | 'pending_settlement'
  | 'missing_on_chain'
  | 'missing_in_ledger'
  | 'amount_mismatch'
  | 'wrong_destination_or_asset'
  | 'duplicate'
  | 'unexpected_extra_payment';

export interface ScheduledPayoutItem {
  payoutId: string;
  bondId: number;
  periodId: string;
  payoutType: PayoutType;
  destination: string;
  assetCode: string;
  assetIssuer: string | null;
  amountMinorUnits: string;
  scheduledAt: string;
}

export interface LedgerPayoutRecord {
  payoutId: string;
  bondId: number;
  periodId: string;
  destination: string;
  assetCode: string;
  assetIssuer: string | null;
  amountMinorUnits: string;
  txHash?: string;
  recordedAt: string;
}

export interface OnChainPayoutEvent {
  eventId: string;
  txHash: string;
  successful: boolean;
  bondId: number;
  periodId: string;
  payoutId?: string;
  destination: string;
  assetCode: string;
  assetIssuer: string | null;
  amountMinorUnits: string;
  ledgerClosedAt: string;
}

export interface OnChainPayoutPage {
  events: OnChainPayoutEvent[];
  nextCursor: string | null;
}

export interface OnChainPayoutClient {
  fetchPayoutEvents(params: {
    bondId: number;
    periodId: string;
    cursor: string | null;
    limit: number;
  }): Promise<OnChainPayoutPage>;
}

export const ON_CHAIN_PAYOUT_CLIENT = Symbol('ON_CHAIN_PAYOUT_CLIENT');

export interface PayoutDiscrepancy {
  id: string;
  payoutId: string | null;
  classification: PayoutDiscrepancyType;
  scheduledAmount: string;
  ledgerAmount: string;
  onChainAmount: string;
  destination?: string;
  assetCode?: string;
  assetIssuer?: string | null;
  txHashes: string[];
  description: string;
}

export type PayoutReconciliationStatus = 'completed' | 'partial';

export interface PayoutReconciliationTotals {
  totalScheduledMinorUnits: string;
  totalLedgerMinorUnits: string;
  totalPaidMinorUnits: string;
  totalExceptionDeltaMinorUnits: string;
  matchedCount: number;
  discrepancyCount: number;
  pendingSettlementCount: number;
}

export interface PayoutReconciliationReport {
  runId: string;
  bondId: number;
  periodId: string;
  status: PayoutReconciliationStatus;
  executedAt: string;
  idempotentReplay: boolean;
  resumeCursor: string | null;
  pagesFetched: number;
  error?: string;
  totals: PayoutReconciliationTotals;
  discrepancies: PayoutDiscrepancy[];
  invariantHolds: boolean;
}

export interface PayoutAdjustmentRecord {
  adjustmentId: string;
  runId: string;
  discrepancyId: string;
  payoutId: string | null;
  reason: string;
  amountDeltaMinorUnits: string;
  actor: string;
  recordedAt: string;
}
