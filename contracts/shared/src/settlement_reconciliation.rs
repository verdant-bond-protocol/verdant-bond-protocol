//! Settlement reconciliation for failed and retried payout transactions (#451).
//!
//! Tracks payout attempts with status transitions (pending → succeeded /
//! failed → retried). Provides reconciliation to identify mismatches between
//! expected payouts and on-chain results.

use soroban_sdk::{contracttype, Address, Env, Map};

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum PayoutStatus {
    Pending,
    Succeeded,
    Failed,
    Retried,
    Settled,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PayoutRecord {
    pub id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub status: PayoutStatus,
    pub tx_hash: Option<soroban_sdk::Bytes>,
    pub attempt_count: u32,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_error: Option<soroban_sdk::String>,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct ReconciliationReport {
    pub total_payouts: u32,
    pub succeeded: u32,
    pub failed: u32,
    pub pending: u32,
    pub retried: u32,
    pub total_expected: i128,
    pub total_settled: i128,
    pub total_outstanding: i128,
}

/// Tracks payout attempts and provides reconciliation.
pub struct SettlementReconciler {
    pub records: Map<u64, PayoutRecord>,
    pub next_id: u64,
}

impl SettlementReconciler {
    pub fn new(env: &Env) -> Self {
        SettlementReconciler {
            records: Map::new(env),
            next_id: 1,
        }
    }

    /// Record a new payout attempt.
    pub fn record_payout(
        &mut self,
        env: &Env,
        recipient: &Address,
        amount: i128,
    ) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let record = PayoutRecord {
            id,
            recipient: recipient.clone(),
            amount,
            status: PayoutStatus::Pending,
            tx_hash: None,
            attempt_count: 1,
            created_at: env.ledger().timestamp(),
            updated_at: env.ledger().timestamp(),
            last_error: None,
        };
        self.records.set(id, record);
        id
    }

    /// Mark a payout as succeeded.
    pub fn mark_succeeded(
        &mut self,
        env: &Env,
        id: u64,
        tx_hash: soroban_sdk::Bytes,
    ) -> bool {
        let Some(mut record) = self.records.get(id) else { return false };
        record.status = PayoutStatus::Succeeded;
        record.tx_hash = Some(tx_hash);
        record.updated_at = env.ledger().timestamp();
        record.last_error = None;
        self.records.set(id, record);
        true
    }

    /// Mark a payout as failed with an error message.
    pub fn mark_failed(
        &mut self,
        env: &Env,
        id: u64,
        error: &str,
    ) -> bool {
        let Some(mut record) = self.records.get(id) else { return false };
        record.status = PayoutStatus::Failed;
        record.updated_at = env.ledger().timestamp();
        record.last_error = Some(soroban_sdk::String::from_str(env, error));
        self.records.set(id, record);
        true
    }

    /// Mark a payout for retry (after a failure).
    pub fn mark_retry(&mut self, env: &Env, id: u64) -> bool {
        let Some(mut record) = self.records.get(id) else { return false };
        record.status = PayoutStatus::Retried;
        record.attempt_count += 1;
        record.updated_at = env.ledger().timestamp();
        self.records.set(id, record);
        true
    }

    /// Generate a reconciliation report across all payouts.
    pub fn reconcile(&self) -> ReconciliationReport {
        let mut report = ReconciliationReport {
            total_payouts: 0,
            succeeded: 0,
            failed: 0,
            pending: 0,
            retried: 0,
            total_expected: 0,
            total_settled: 0,
            total_outstanding: 0,
        };

        for (_, record) in self.records.iter() {
            report.total_payouts += 1;
            report.total_expected += record.amount;
            match record.status {
                PayoutStatus::Succeeded | PayoutStatus::Settled => {
                    report.succeeded += 1;
                    report.total_settled += record.amount;
                }
                PayoutStatus::Failed => {
                    report.failed += 1;
                    report.total_outstanding += record.amount;
                }
                PayoutStatus::Pending => {
                    report.pending += 1;
                    report.total_outstanding += record.amount;
                }
                PayoutStatus::Retried => {
                    report.retried += 1;
                    report.total_outstanding += record.amount;
                }
            }
        }

        report
    }
}
