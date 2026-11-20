#![cfg(test)]
use soroban_sdk::{Address, Env};

use crate::{
    coupon_pause::{is_distribution_paused, pause_distribution, resume_distribution, PauseState},
    jurisdiction_versioning::JurisdictionRegistry,
    methodology_snapshot::{MethodologySnapshot, MethodologySnapshots},
    settlement_reconciliation::{SettlementReconciler, PayoutStatus},
    liability_reserve_alert::{AlertError, AlertSeverity, AlertStatus, LiabilityReserveAlertManager},
};

fn setup_env() -> Env {
    Env::default()
}

// ─── Coupon pause/resume (#453) ──────────────────────────────────────────────

#[test]
fn test_pause_and_resume_distribution() {
    let env = setup_env();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let paused = pause_distribution(&env, &admin, 1, "maintenance");
    assert!(is_distribution_paused(&paused));
    assert_eq!(paused.paused_by, Some(admin.clone()));
    assert!(paused.paused_at.is_some());

    let resumed = resume_distribution(&env, &admin);
    assert!(!is_distribution_paused(&resumed));
    assert_eq!(resumed.paused_by, Some(admin.clone()));
}

#[test]
fn test_pause_is_idempotent() {
    let env = setup_env();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let p1 = pause_distribution(&env, &admin, 1, "first");
    let p2 = pause_distribution(&env, &admin, 1, "second");
    assert!(is_distribution_paused(&p1));
    assert!(is_distribution_paused(&p2));
}

#[test]
fn test_resume_is_idempotent() {
    let env = setup_env();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let r1 = resume_distribution(&env, &admin);
    let r2 = resume_distribution(&env, &admin);
    assert!(!is_distribution_paused(&r1));
    assert!(!is_distribution_paused(&r2));
}

#[test]
fn test_default_state_is_not_paused() {
    let state = PauseState {
        paused: false,
        paused_by: None,
        paused_at: None,
        reason: soroban_sdk::String::from_str(&Env::default(), ""),
    };
    assert!(!is_distribution_paused(&state));
}

// ─── Jurisdiction rule versioning (#450) ─────────────────────────────────────

#[test]
fn test_add_rule_and_lock_investor() {
    let env = setup_env();
    let mut registry = JurisdictionRegistry::new(&env);
    let investor = Address::generate(&env);

    let v1 = registry.add_rule(
        &env,
        soroban_sdk::String::from_str(&env, "US"),
        1_000_000,
        true,
    );
    assert_eq!(v1, 1);

    registry.lock_investor(&env, &investor);
    assert_eq!(registry.get_investor_version(&investor), Some(1));
}

#[test]
fn test_investor_keeps_original_version_on_rule_change() {
    let env = setup_env();
    let mut registry = JurisdictionRegistry::new(&env);
    let investor = Address::generate(&env);

    registry.add_rule(&env, soroban_sdk::String::from_str(&env, "US"), 1_000_000, true);
    registry.lock_investor(&env, &investor);

    // Add a new rule version
    registry.add_rule(&env, soroban_sdk::String::from_str(&env, "US"), 500_000, true);

    // Investor stays on v1
    assert_eq!(registry.get_investor_version(&investor), Some(1));
}

#[test]
fn test_migrate_investor_to_latest() {
    let env = setup_env();
    let mut registry = JurisdictionRegistry::new(&env);
    let investor = Address::generate(&env);

    registry.add_rule(&env, soroban_sdk::String::from_str(&env, "US"), 1_000_000, true);
    registry.lock_investor(&env, &investor);
    registry.add_rule(&env, soroban_sdk::String::from_str(&env, "US"), 500_000, true);

    let new_version = registry.migrate_investor(&env, &investor);
    assert_eq!(new_version, Some(2));
    assert_eq!(registry.get_investor_version(&investor), Some(2));
}

// ─── Settlement reconciliation (#451) ────────────────────────────────────────

#[test]
fn test_record_and_settle_payout() {
    let env = setup_env();
    let mut reconciler = SettlementReconciler::new(&env);
    let recipient = Address::generate(&env);

    let id = reconciler.record_payout(&env, &recipient, 1000);
    assert_eq!(id, 1);

    reconciler.mark_succeeded(&env, id, soroban_sdk::Bytes::from_slice(&env, b"txhash"));
    let report = reconciler.reconcile();
    assert_eq!(report.succeeded, 1);
    assert_eq!(report.total_settled, 1000);
}

#[test]
fn test_failed_payout_tracking() {
    let env = setup_env();
    let mut reconciler = SettlementReconciler::new(&env);
    let recipient = Address::generate(&env);

    let id = reconciler.record_payout(&env, &recipient, 500);
    reconciler.mark_failed(&env, id, "insufficient balance");

    let report = reconciler.reconcile();
    assert_eq!(report.failed, 1);
    assert_eq!(report.total_outstanding, 500);
}

#[test]
fn test_retry_increments_attempt_count() {
    let env = setup_env();
    let mut reconciler = SettlementReconciler::new(&env);
    let recipient = Address::generate(&env);

    let id = reconciler.record_payout(&env, &recipient, 1000);
    reconciler.mark_failed(&env, id, "timeout");
    reconciler.mark_retry(&env, id);

    let report = reconciler.reconcile();
    assert_eq!(report.retried, 1);
    assert_eq!(report.total_outstanding, 1000);
}

#[test]
fn test_reconciliation_totals() {
    let env = setup_env();
    let mut reconciler = SettlementReconciler::new(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    let id1 = reconciler.record_payout(&env, &a, 100);
    let _id2 = reconciler.record_payout(&env, &b, 200);
    reconciler.mark_succeeded(&env, id1, soroban_sdk::Bytes::from_slice(&env, b"tx1"));

    let report = reconciler.reconcile();
    assert_eq!(report.total_payouts, 2);
    assert_eq!(report.total_expected, 300);
    assert_eq!(report.total_settled, 100);
    assert_eq!(report.total_outstanding, 200);
}

// ─── Methodology snapshots (#452) ────────────────────────────────────────────

#[test]
fn test_record_and_get_snapshot() {
    let env = setup_env();
    let mut snapshots = MethodologySnapshots::new(&env);

    let snapshot = MethodologySnapshot {
        bond_id: 1,
        methodology_id: soroban_sdk::String::from_str(&env, "BLUE-CARBON"),
        methodology_version: 1,
        credit_type: soroban_sdk::String::from_str(&env, "BlueCarbon"),
        verification_standard: soroban_sdk::String::from_str(&env, "VCS"),
        oracle_config_hash: soroban_sdk::BytesN::from_array(&env, &[1u8; 32]),
        total_credits: 1_000_000,
        issued_at: env.ledger().timestamp(),
        content_hash: soroban_sdk::BytesN::from_array(&env, &[2u8; 32]),
    };

    snapshots.record(&env, snapshot.clone());
    let retrieved = snapshots.get_by_bond(1);
    assert!(retrieved.is_some());
    assert_eq!(retrieved.unwrap().methodology_id, snapshot.methodology_id);
}

#[test]
fn test_snapshot_is_immutable() {
    let env = setup_env();
    let mut snapshots = MethodologySnapshots::new(&env);

    let snapshot = MethodologySnapshot {
        bond_id: 1,
        methodology_id: soroban_sdk::String::from_str(&env, "BLUE-CARBON"),
        methodology_version: 1,
        credit_type: soroban_sdk::String::from_str(&env, "BlueCarbon"),
        verification_standard: soroban_sdk::String::from_str(&env, "VCS"),
        oracle_config_hash: soroban_sdk::BytesN::from_array(&env, &[1u8; 32]),
        total_credits: 1_000_000,
        issued_at: env.ledger().timestamp(),
        content_hash: soroban_sdk::BytesN::from_array(&env, &[2u8; 32]),
    };

    snapshots.record(&env, snapshot.clone());
    let original = snapshots.get_by_bond(1).unwrap();

    // Attempting to record a different snapshot for the same bond creates
    // a new entry (append-only), the original remains unchanged.
    snapshots.record(&env, MethodologySnapshot {
        bond_id: 1,
        total_credits: 999_999,
        ..snapshot
    });

    // First snapshot is still accessible and unchanged
    let entries: Vec<_> = snapshots.snapshots.iter().collect();
    assert_eq!(entries[0].total_credits, 1_000_000);
    assert_eq!(entries[0].methodology_id, original.methodology_id);
}

#[test]
fn test_verify_integrity() {
    let env = setup_env();
    let snapshots = MethodologySnapshots::new(&env);

    let valid = MethodologySnapshot {
        bond_id: 1,
        methodology_id: soroban_sdk::String::from_str(&env, "BLUE-CARBON"),
        methodology_version: 1,
        credit_type: soroban_sdk::String::from_str(&env, "BlueCarbon"),
        verification_standard: soroban_sdk::String::from_str(&env, "VCS"),
        oracle_config_hash: soroban_sdk::BytesN::from_array(&env, &[1u8; 32]),
        total_credits: 1_000_000,
        issued_at: 1000,
        content_hash: soroban_sdk::BytesN::from_array(&env, &[2u8; 32]),
    };
    assert!(snapshots.verify_integrity(&valid));

    let invalid = MethodologySnapshot {
        content_hash: soroban_sdk::BytesN::from_array(&env, &[0u8; 32]),
        ..valid
    };
    assert!(!snapshots.verify_integrity(&invalid));
}

// ─── Liability vs Reserve Alerting ──────────────────────────────────────────

#[test]
fn test_alert_triggered_when_liabilities_exceed_reserves_normal_path() {
    let env = setup_env();
    let mut manager = LiabilityReserveAlertManager::new(&env, 9000, 8000).unwrap();

    // Bond with 10,000,000 liabilities and only 7,500,000 in reserves (75% coverage -> CriticalDeficit)
    let alert_opt = manager
        .evaluate_funding(&env, 101, 10_000_000, 7_500_000, "Quarterly liability rebalance")
        .unwrap();

    assert!(alert_opt.is_some());
    let alert = alert_opt.unwrap();
    assert_eq!(alert.bond_id, 101);
    assert_eq!(alert.shortfall, 2_500_000);
    assert_eq!(alert.coverage_fraction_bps, 7500);
    assert_eq!(alert.severity, AlertSeverity::CriticalDeficit);
    assert_eq!(alert.status, AlertStatus::Active);
    assert_eq!(alert.retry_count, 0);

    // Verify active alert tracking
    let active = manager.get_active_alert(101).unwrap();
    assert_eq!(active.alert_id, alert.alert_id);
}

#[test]
fn test_adequate_reserves_auto_resolves_active_alert_normal_path() {
    let env = setup_env();
    let mut manager = LiabilityReserveAlertManager::new(&env, 9000, 8000).unwrap();

    // Trigger deficit alert
    manager
        .evaluate_funding(&env, 101, 10_000_000, 7_000_000, "Initial deficit")
        .unwrap();
    assert!(manager.get_active_alert(101).is_some());

    // Reserves replenished to 10,000,000 (100% coverage -> auto-resolves)
    let resolved_opt = manager
        .evaluate_funding(&env, 101, 10_000_000, 10_000_000, "Replenished")
        .unwrap();

    assert!(resolved_opt.is_some());
    let resolved = resolved_opt.unwrap();
    assert_eq!(resolved.status, AlertStatus::Resolved);
    assert_eq!(resolved.shortfall, 0);
    assert_eq!(resolved.coverage_fraction_bps, 10000);
    assert_eq!(resolved.severity, AlertSeverity::Adequate);
    assert!(resolved.resolved_at.is_some());

    // Active alert cleared
    assert!(manager.get_active_alert(101).is_none());
}

#[test]
fn test_retry_path_idempotent_alert_update_without_duplication() {
    let env = setup_env();
    let mut manager = LiabilityReserveAlertManager::new(&env, 9000, 8000).unwrap();

    // First scan creates alert #1
    let alert1 = manager
        .evaluate_funding(&env, 102, 10_000_000, 7_000_000, "Scan 1")
        .unwrap()
        .unwrap();
    assert_eq!(alert1.alert_id, 1);
    assert_eq!(alert1.retry_count, 0);

    // Retry scan with same severity increments retry_count without creating new alert ID
    let alert2 = manager
        .evaluate_funding(&env, 102, 10_000_000, 7_200_000, "Scan 2 retry")
        .unwrap()
        .unwrap();
    assert_eq!(alert2.alert_id, 1); // same alert ID preserved
    assert_eq!(alert2.retry_count, 1);
    assert_eq!(alert2.shortfall, 2_800_000);
    assert_eq!(alert2.available_reserves, 7_200_000);

    // Another retry
    let alert3 = manager
        .evaluate_funding(&env, 102, 10_000_000, 7_100_000, "Scan 3 retry")
        .unwrap()
        .unwrap();
    assert_eq!(alert3.alert_id, 1);
    assert_eq!(alert3.retry_count, 2);
}

#[test]
fn test_severity_escalation_when_deficit_deepens() {
    let env = setup_env();
    let mut manager = LiabilityReserveAlertManager::new(&env, 9000, 8000).unwrap();

    // Initial warning (85% coverage)
    let alert1 = manager
        .evaluate_funding(&env, 103, 10_000_000, 8_500_000, "Warning level")
        .unwrap()
        .unwrap();
    assert_eq!(alert1.severity, AlertSeverity::Warning);

    // Deficit deepens to EmergencyInsolvency (40% coverage) -> creates escalated alert
    let alert2 = manager
        .evaluate_funding(&env, 103, 10_000_000, 4_000_000, "Severe insolvency")
        .unwrap()
        .unwrap();
    assert_eq!(alert2.severity, AlertSeverity::EmergencyInsolvency);
    assert_eq!(alert2.shortfall, 6_000_000);
    assert_ne!(alert2.alert_id, alert1.alert_id);
}

#[test]
fn test_failure_path_negative_values_and_invalid_thresholds() {
    let env = setup_env();

    // Invalid threshold (warning < critical)
    let bad_mgr = LiabilityReserveAlertManager::new(&env, 7000, 8000);
    assert_eq!(bad_mgr.err(), Some(AlertError::InvalidThreshold));

    let mut manager = LiabilityReserveAlertManager::new(&env, 9000, 8000).unwrap();

    // Negative liabilities
    let res1 = manager.evaluate_funding(&env, 104, -1, 5_000_000, "Negative liabilities");
    assert_eq!(res1.err(), Some(AlertError::NegativeValue));

    // Negative reserves
    let res2 = manager.evaluate_funding(&env, 104, 10_000_000, -100, "Negative reserves");
    assert_eq!(res2.err(), Some(AlertError::NegativeValue));
}

#[test]
fn test_authorization_path_admin_acknowledgment_and_resolution() {
    let env = setup_env();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let mut manager = LiabilityReserveAlertManager::new(&env, 9000, 8000).unwrap();

    let alert = manager
        .evaluate_funding(&env, 105, 5_000_000, 3_000_000, "Deficit needing ack")
        .unwrap()
        .unwrap();
    assert_eq!(alert.status, AlertStatus::Active);

    // Admin acknowledges alert
    let acked = manager.acknowledge_alert(&env, &admin, alert.alert_id).unwrap();
    assert_eq!(acked.status, AlertStatus::Acknowledged);
    assert_eq!(acked.acknowledged_by, Some(admin.clone()));
    assert!(acked.acknowledged_at.is_some());

    // Duplicate acknowledgment fails
    let dup_ack = manager.acknowledge_alert(&env, &admin, alert.alert_id);
    assert_eq!(dup_ack.err(), Some(AlertError::AlreadyAcknowledged));

    // Resolution with insufficient replenishment fails
    let bad_res = manager.resolve_alert(&env, &admin, alert.alert_id, 1_000_000);
    assert_eq!(bad_res.err(), Some(AlertError::InsufficientReplenishment));

    // Resolution with full shortfall replenishment succeeds
    let resolved = manager
        .resolve_alert(&env, &admin, alert.alert_id, 2_000_000)
        .unwrap();
    assert_eq!(resolved.status, AlertStatus::Resolved);
    assert_eq!(resolved.shortfall, 0);
    assert_eq!(resolved.coverage_fraction_bps, 10000);
    assert!(manager.get_active_alert(105).is_none());
}

