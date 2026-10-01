use soroban_sdk::{contracttype, Address, BytesN, Symbol, Vec};

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum CreditType {
    Carbon,
    Biodiversity,
    Basket,
    BlueCarbon,
}

impl CreditType {
    /// Number of decimal places used to represent credit quantities in minor
    /// units on-chain. Every type currently shares a 6-decimal precision so
    /// proportional coupon shares can be expressed exactly.
    pub const fn decimals(self) -> u32 {
        match self {
            CreditType::Carbon
            | CreditType::Biodiversity
            | CreditType::Basket
            | CreditType::BlueCarbon => 6,
        }
    }

    /// Minor units per whole credit for this type (`10^decimals`).
    pub const fn minor_units(self) -> i128 {
        match self.decimals() {
            6 => 1_000_000,
            d => 10i128.pow(d),
        }
    }
}

/// Canonical oracle methodology symbols for the registered providers.
pub mod methodology {
    /// Blue carbon (mangrove, seagrass, saltmarsh) monitoring.
    pub const BLUE_CARBON: &str = "BLUE-CARBON";
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum BiodiversityMetrics {
    Absent,
    Present((i128, i128, i128)),
}

#[derive(Clone, Debug)]
#[contracttype]
pub struct BondConfig {
    pub project_id: BytesN<32>,
    pub face_value: i128,
    pub coupon_schedule: Vec<u64>,
    pub credit_type: CreditType,
    pub maturity_date: u64,
    pub total_supply: i128,
    pub credit_vintage: u64,
    pub serial_number_start: i128,
    pub serial_number_end: i128,
}

/// Aggregated redemption funding view for a bond (Issue #150).
///
/// - `total_principal_due` is the total outstanding subscribed principal,
///   which is what holders are owed at face value on redemption.
/// - `funded_amount` is the escrowed redemption pool.
/// - `shortfall` is `total_principal_due - funded_amount`, saturated at zero.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct RedemptionCoverage {
    pub total_principal_due: i128,
    pub funded_amount: i128,
    pub shortfall: i128,
    pub coverage_fraction_bps: u64,
}

pub type BondId = u64;
pub type ReportId = u64;
pub type OrderId = u64;

/// A sequestration report as stored by oracle-consumer. Lives here so that
/// coupon-engine can decode it over `invoke_contract` without linking the
/// oracle-consumer contract crate, which would duplicate its exported
/// symbols in coupon-engine's wasm.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Report {
    pub id: u64,
    pub provider: Address,
    pub project_id: BytesN<32>,
    pub period_start: u64,
    pub period_end: u64,
    pub carbon_sequestered: i128,
    pub biodiversity: BiodiversityMetrics,
    pub methodology: Symbol,
    pub ipfs_evidence_hash: BytesN<32>,
    pub status: ReportStatus,
    pub submitted_at: u64,
    pub verified_at: u64,
    pub provider_stake_at_verification: Option<i128>,
}

#[derive(Clone)]
#[contracttype]
pub struct OracleReport {
    pub project_id: BytesN<32>,
    pub period_start: u64,
    pub period_end: u64,
    pub carbon_sequestered: i128,
    pub methodology: Symbol,
    pub provider_signature: BytesN<64>,
    pub ipfs_evidence_hash: BytesN<32>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum BondStatus {
    Active,
    Matured,
    Defaulted,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum ProjectStatus {
    Pending,
    Approved,
    Rejected,
    Inactive,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum ReportStatus {
    Pending,
    Verified,
    Challenged,
    Rejected,
}

/// Periodic CarbonChain audit true-up adjustment applied forward to next coupon period (#194).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct TrueUpAdjustment {
    pub bond_id: u64,
    pub period_index: u32,
    pub adjustment_amount: i128,
    pub reason: Symbol,
    pub ipfs_evidence_hash: BytesN<32>,
    pub timestamp: u64,
    pub applied: bool,
}

/// Per-project staleness config with tiered fallback thresholds (#192).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct ProjectStalenessConfig {
    pub threshold1_secs: u64,
    pub threshold2_secs: u64,
    pub conservatism_discount_bps: u64,
}

/// Observability view for project oracle staleness status (#192).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct StalenessState {
    pub project_id: BytesN<32>,
    pub last_report_timestamp: u64,
    pub current_tier: u32,
    pub time_elapsed: u64,
    pub discount_bps: u64,
}
