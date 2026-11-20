//! Alerting when bond liabilities exceed available reserve funding.
//!
//! Tracks bond liabilities (principal and coupon payment obligations) against
//! available reserve funding (redemption escrow, liquidity buffers, and penalty reserves).
//!
//! Enforces:
//! - Normal path: detects shortfall, triggers alerts with appropriate severity (Warning vs Critical),
//!   and auto-resolves active alerts when reserves are fully replenished.
//! - Failure path: rejects negative values, invalid thresholds, and underfunded resolution attempts.
//! - Retry path: updates existing active alerts idempotently (increments retry_count) without
//!   duplicating alert records unless severity escalates.
//! - Authorization path: requires administrator authorization for acknowledgment and manual resolution.
//! - Financial invariants: conservation of shortfall, bounded coverage basis points [0, 10000],
//!   and monotonicity.

use soroban_sdk::{contracttype, Address, Env, Map, Symbol};

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum AlertSeverity {
    Adequate = 0,
    Warning = 1,
    CriticalDeficit = 2,
    EmergencyInsolvency = 3,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum AlertStatus {
    Active = 0,
    Acknowledged = 1,
    Resolved = 2,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AlertError {
    Unauthorized,
    NegativeValue,
    InvalidThreshold,
    AlertNotFound,
    AlreadyResolved,
    AlreadyAcknowledged,
    InsufficientReplenishment,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct LiabilityReserveAlert {
    pub alert_id: u64,
    pub bond_id: u64,
    pub liabilities: i128,
    pub available_reserves: i128,
    pub shortfall: i128,
    pub coverage_fraction_bps: u64,
    pub severity: AlertSeverity,
    pub status: AlertStatus,
    pub triggered_at: u64,
    pub acknowledged_by: Option<Address>,
    pub acknowledged_at: Option<u64>,
    pub resolved_at: Option<u64>,
    pub retry_count: u32,
    pub reason: soroban_sdk::String,
}

/// Manages liability vs reserve alerting and lifecycle transitions.
pub struct LiabilityReserveAlertManager {
    pub alerts: Map<u64, LiabilityReserveAlert>,
    pub bond_active_alerts: Map<u64, u64>,
    pub warning_threshold_bps: u64,
    pub critical_threshold_bps: u64,
    pub next_alert_id: u64,
}

impl LiabilityReserveAlertManager {
    pub fn new(env: &Env, warning_threshold_bps: u64, critical_threshold_bps: u64) -> Result<Self, AlertError> {
        if warning_threshold_bps < critical_threshold_bps || warning_threshold_bps > 10000 {
            return Err(AlertError::InvalidThreshold);
        }
        Ok(LiabilityReserveAlertManager {
            alerts: Map::new(env),
            bond_active_alerts: Map::new(env),
            warning_threshold_bps,
            critical_threshold_bps,
            next_alert_id: 1,
        })
    }

    /// Evaluates bond liabilities against available reserve funding.
    ///
    /// - Normal Path:
    ///   - If reserves < liabilities: computes shortfall and coverage BPS, creates or escalates alert.
    ///   - If reserves >= liabilities: auto-resolves any active alert for this bond.
    /// - Failure Path:
    ///   - Rejects negative liabilities or reserves.
    /// - Retry Path:
    ///   - If active alert already exists with same severity, increments `retry_count` and updates
    ///     shortfall/timestamp without duplicating alert IDs.
    pub fn evaluate_funding(
        &mut self,
        env: &Env,
        bond_id: u64,
        liabilities: i128,
        available_reserves: i128,
        reason: &str,
    ) -> Result<Option<LiabilityReserveAlert>, AlertError> {
        if liabilities < 0 || available_reserves < 0 {
            return Err(AlertError::NegativeValue);
        }

        let now = env.ledger().timestamp();

        // 1. Fully funded or zero liabilities (Normal adequate/resolution path)
        if liabilities == 0 || available_reserves >= liabilities {
            if let Some(active_id) = self.bond_active_alerts.get(bond_id) {
                if let Some(mut alert) = self.alerts.get(active_id) {
                    alert.status = AlertStatus::Resolved;
                    alert.resolved_at = Some(now);
                    alert.available_reserves = available_reserves;
                    alert.shortfall = 0;
                    alert.coverage_fraction_bps = 10000;
                    alert.severity = AlertSeverity::Adequate;
                    self.alerts.set(active_id, alert.clone());
                    self.bond_active_alerts.remove(bond_id);
                    return Ok(Some(alert));
                }
            }
            return Ok(None);
        }

        // 2. Liabilities exceed reserves (Deficit detected)
        let shortfall = liabilities - available_reserves;
        let numerator = (available_reserves as u128).saturating_mul(10000);
        let coverage_fraction_bps = (numerator / liabilities as u128).min(10000) as u64;

        let severity = if coverage_fraction_bps <= 5000 {
            AlertSeverity::EmergencyInsolvency
        } else if coverage_fraction_bps <= self.critical_threshold_bps {
            AlertSeverity::CriticalDeficit
        } else {
            AlertSeverity::Warning
        };

        // 3. Retry Path: check if active alert already exists for this bond
        if let Some(active_id) = self.bond_active_alerts.get(bond_id) {
            if let Some(mut existing) = self.alerts.get(active_id) {
                if existing.severity == severity {
                    // Idempotent retry update
                    existing.retry_count += 1;
                    existing.shortfall = shortfall;
                    existing.available_reserves = available_reserves;
                    existing.liabilities = liabilities;
                    existing.coverage_fraction_bps = coverage_fraction_bps;
                    existing.triggered_at = now;
                    self.alerts.set(active_id, existing.clone());
                    return Ok(Some(existing));
                }
                // Severity escalated (e.g. Warning -> CriticalDeficit)
                existing.status = AlertStatus::Resolved;
                existing.resolved_at = Some(now);
                self.alerts.set(active_id, existing);
            }
        }

        // 4. Create new alert
        let alert_id = self.next_alert_id;
        self.next_alert_id += 1;

        let alert = LiabilityReserveAlert {
            alert_id,
            bond_id,
            liabilities,
            available_reserves,
            shortfall,
            coverage_fraction_bps,
            severity,
            status: AlertStatus::Active,
            triggered_at: now,
            acknowledged_by: None,
            acknowledged_at: None,
            resolved_at: None,
            retry_count: 0,
            reason: soroban_sdk::String::from_str(env, reason),
        };

        self.alerts.set(alert_id, alert.clone());
        self.bond_active_alerts.set(bond_id, alert_id);

        env.events().publish(
            (Symbol::new(env, "reserve_shortfall_alert"),),
            (bond_id, shortfall, coverage_fraction_bps),
        );

        Ok(Some(alert))
    }

    /// Authorization Path: Administrator acknowledges an active alert.
    pub fn acknowledge_alert(
        &mut self,
        env: &Env,
        admin: &Address,
        alert_id: u64,
    ) -> Result<LiabilityReserveAlert, AlertError> {
        admin.require_auth();

        let mut alert = self.alerts.get(alert_id).ok_or(AlertError::AlertNotFound)?;

        if alert.status == AlertStatus::Resolved {
            return Err(AlertError::AlreadyResolved);
        }
        if alert.status == AlertStatus::Acknowledged {
            return Err(AlertError::AlreadyAcknowledged);
        }

        alert.status = AlertStatus::Acknowledged;
        alert.acknowledged_by = Some(admin.clone());
        alert.acknowledged_at = Some(env.ledger().timestamp());

        self.alerts.set(alert_id, alert.clone());
        Ok(alert)
    }

    /// Authorization Path: Administrator resolves an alert with reserve replenishment.
    pub fn resolve_alert(
        &mut self,
        env: &Env,
        admin: &Address,
        alert_id: u64,
        replenished_amount: i128,
    ) -> Result<LiabilityReserveAlert, AlertError> {
        admin.require_auth();

        let mut alert = self.alerts.get(alert_id).ok_or(AlertError::AlertNotFound)?;

        if alert.status == AlertStatus::Resolved {
            return Err(AlertError::AlreadyResolved);
        }

        // Failure Path: verify replenishment eliminates shortfall
        if replenished_amount < alert.shortfall {
            return Err(AlertError::InsufficientReplenishment);
        }

        alert.status = AlertStatus::Resolved;
        alert.resolved_at = Some(env.ledger().timestamp());
        alert.available_reserves += replenished_amount;
        alert.shortfall = 0;
        alert.coverage_fraction_bps = 10000;
        alert.severity = AlertSeverity::Adequate;

        self.alerts.set(alert_id, alert.clone());
        self.bond_active_alerts.remove(alert.bond_id);

        Ok(alert)
    }

    /// Get active alert for a bond, if any.
    pub fn get_active_alert(&self, bond_id: u64) -> Option<LiabilityReserveAlert> {
        let active_id = self.bond_active_alerts.get(bond_id)?;
        self.alerts.get(active_id)
    }
}
