#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]
use nbbs_shared::Report;
use nbbs_shared::{
    BiodiversityMetrics, BondError, CreditType, ReportStatus, StalenessState, TrueUpAdjustment,
};
use soroban_sdk::{
    contract, contractimpl, contracttype, vec, Address, BytesN, Env, IntoVal, Symbol, Vec,
};

pub const FIXED_POINT: i128 = 10_000_000;
pub const CREDIT_DIVISOR: i128 = 1_000;
/// Minor units per whole credit (6 decimals), matching every credit type.
/// All on-chain credit amounts are denominated in minor units so proportional
/// coupon shares below a whole credit can be represented exactly.
pub const CREDIT_MINOR_UNITS: i128 = 1_000_000;
pub const HABITAT_CREDIT_RATE: i128 = 1_000_000;
pub const SPECIES_CREDIT_RATE: i128 = 100_000;
pub const UNIT_CREDIT_RATE: i128 = 1_000_000;
pub const MAX_COUPON_BATCH_SIZE: u32 = 100;
pub const MAX_WATERFALL_TRANCHES: u32 = 100;
/// Largest supported coupon pool per bond and period, in minor credit units.
pub const MAX_COUPON_POOL: i128 = 1_000_000_000_000_000_000;

// Issue #186 — oracle-fed performance validation bounds. Rationale is
// documented in docs/coupon-performance-validation.md.
/// Maximum period-over-period increase, in basis points (+100%).
pub const MAX_PERFORMANCE_INCREASE_BPS: i128 = 10_000;
/// Maximum period-over-period drop, in basis points (-90%). Genuine sudden
/// ecological collapse is possible, so drops are flagged for review rather
/// than silently clamped.
pub const MAX_PERFORMANCE_DECREASE_BPS: i128 = 9_000;
/// Independent verifiers required before a report may drive coupon payouts.
pub const MIN_PERFORMANCE_ATTESTATIONS: u32 = 2;
/// Number of trailing periods kept for rate-of-change checks.
pub const TRAILING_HISTORY_PERIODS: u32 = 8;

/// Issue #188: versioned-interface convention. Bump on a breaking storage
/// layout or interface change; see docs/upgrade-migrations.md.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    PeriodInfo(u64, u32),
    PeriodBatchCursor(u64, u32),
    PeriodCount(u64),
    EscrowedCredits(u64, Address),
    EscrowedCreditsByType(u64, Address, CreditType),
    BondProject(u64),
    BondCreditType(u64),
    UndistributedTotal(u64),
    Precision,
    BondIssuerAddress,
    OracleConsumerAddress,
    Nonce(Address),
    /// Per-period, per-type holder accrual ledger backing the itemized
    /// claimable-credit provenance view (#156).
    PeriodHolder(u64, u32, Address, CreditType),
    /// Open migration window pausing coupon writes for a bond (#188).
    MigrationWindow(u64),
    /// Trailing verified performance observations per bond (#186).
    PerformanceHistory(u64),
    /// Active performance flag pausing coupon distribution for a bond (#186).
    PerformanceFlag(u64),
    /// Minimum independent attestations required before distribution (#186).
    MinPerformanceAttestations,
    /// CarbonChain audit true-up adjustment records per bond (#194).
    TrueUpAdjustment(u64, u32),
    TrueUpCount(u64),
    /// Aggregate senior-first waterfall obligations and the latest settlement
    /// allocations. These are keyed by bond, not by investor.
    WaterfallCarry(u64),
    WaterfallAllocations(u64),
    WaterfallSettlementCount(u64),
    WaterfallSettlementAllocations(u64, u32),
    WaterfallClaimed(u64, u32, u32, Address),
    WaterfallAccrued(u64, Address, CreditType),
}

#[derive(Clone)]
#[contracttype]
pub struct PeriodInfo {
    pub period_index: u32,
    pub start_time: u64,
    pub end_time: u64,
    pub total_credits_earned: i128,
    pub distributed: bool,
    pub report_id: u64,
    pub undistributed: i128,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct CouponResult {
    pub bond_id: u64,
    pub period_index: u32,
    pub total_credits: i128,
    pub holder_count: u32,
    pub credits_per_token: i128,
}

/// Aggregate obligation for one waterfall priority. Lower priorities are
/// senior and must be supplied in strictly ascending order.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct WaterfallTranche {
    pub priority: u32,
    pub tranche_bond_id: u64,
    pub carbon_due: i128,
    pub biodiversity_due: i128,
}

/// Settlement result for one priority. Carbon and biodiversity are funded
/// independently and never substitute for one another.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct WaterfallAllocation {
    pub priority: u32,
    pub tranche_bond_id: u64,
    pub snapshot_version: u64,
    pub carbon_due: i128,
    pub carbon_paid: i128,
    pub biodiversity_due: i128,
    pub biodiversity_paid: i128,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct WaterfallResult {
    pub allocations: Vec<WaterfallAllocation>,
    pub carry: Vec<WaterfallTranche>,
    pub carbon_remaining: i128,
    pub biodiversity_remaining: i128,
}

/// One line of the itemized claimable-credit provenance view (#156): the
/// period, the underlying report, the credit type and the unclaimed amount in
/// minor units.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct ClaimableCreditDetail {
    pub period_index: u32,
    pub report_id: u64,
    pub start_time: u64,
    pub end_time: u64,
    pub credit_type: CreditType,
    pub amount: i128,
}

/// One verified performance observation kept in the trailing history (#186).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PerformanceRecord {
    pub period_index: u32,
    pub report_id: u64,
    pub carbon_sequestered: i128,
}

/// Why an update was flagged (#186).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum PerformanceAnomaly {
    /// Increase beyond `MAX_PERFORMANCE_INCREASE_BPS` — consistent with a
    /// manipulated or erroneous feed.
    Spike,
    /// Drop beyond `MAX_PERFORMANCE_DECREASE_BPS` — either a genuine
    /// catastrophic event or a bad feed; routed to review either way.
    Drop,
}

/// A flagged update pausing automatic coupon distribution for a bond (#186).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PerformanceFlag {
    pub report_id: u64,
    pub reason: PerformanceAnomaly,
    pub previous_value: i128,
    pub reported_value: i128,
    pub flagged_at: u64,
}

/// Open migration window for a bond (#188): coupon writes are paused and the
/// in-flight state is snapshotted so a rollback can prove nothing was lost.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct MigrationWindow {
    pub started_at: u64,
    pub snapshot_undistributed: i128,
    pub snapshot_period_count: u32,
}

#[contract]
pub struct CouponEngine;

#[contractimpl]
impl CouponEngine {
    pub fn __constructor(
        env: Env,
        admin: Address,
        bond_issuer_address: Address,
        oracle_consumer_address: Address,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::BondIssuerAddress, &bond_issuer_address);
        env.storage()
            .instance()
            .set(&DataKey::OracleConsumerAddress, &oracle_consumer_address);
        env.storage()
            .instance()
            .set(&DataKey::Precision, &FIXED_POINT);
    }

    pub fn get_nonce(env: Env, address: Address) -> u64 {
        get_nonce(&env, &address)
    }

    pub fn register_bond(
        env: Env,
        caller: Address,
        bond_id: u64,
        project_id: BytesN<32>,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        env.storage()
            .instance()
            .set(&DataKey::BondProject(bond_id), &project_id);

        let bond_issuer: Address = env
            .storage()
            .instance()
            .get(&DataKey::BondIssuerAddress)
            .ok_or(BondError::NotInitialized)?;
        let config: nbbs_shared::BondConfig = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "get_bond"),
            vec![&env, bond_id.into_val(&env)],
        );
        env.storage()
            .instance()
            .set(&DataKey::BondCreditType(bond_id), &config.credit_type);

        env.events().publish(
            (Symbol::new(&env, "bond_registered"),),
            (bond_id, project_id),
        );

        Ok(())
    }

    pub fn submit_true_up_adjustment(
        env: Env,
        caller: Address,
        bond_id: u64,
        period_index: u32,
        adjustment_amount: i128,
        reason: Symbol,
        ipfs_evidence_hash: BytesN<32>,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TrueUpCount(bond_id))
            .unwrap_or(0);

        let adjustment = TrueUpAdjustment {
            bond_id,
            period_index,
            adjustment_amount,
            reason: reason.clone(),
            ipfs_evidence_hash,
            timestamp: env.ledger().timestamp(),
            applied: false,
        };

        env.storage()
            .persistent()
            .set(&DataKey::TrueUpAdjustment(bond_id, count), &adjustment);
        env.storage()
            .persistent()
            .set(&DataKey::TrueUpCount(bond_id), &(count + 1));

        env.events().publish(
            (Symbol::new(&env, "true_up_adjustment_submitted"),),
            (bond_id, period_index, adjustment_amount),
        );

        Ok(())
    }

    pub fn get_true_up_adjustments(env: Env, bond_id: u64) -> Vec<TrueUpAdjustment> {
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::TrueUpCount(bond_id))
            .unwrap_or(0);
        let mut res = Vec::new(&env);
        for i in 0..count {
            if let Some(adj) = env
                .storage()
                .persistent()
                .get::<_, TrueUpAdjustment>(&DataKey::TrueUpAdjustment(bond_id, i))
            {
                res.push_back(adj);
            }
        }
        res
    }

    /// Settle aggregate obligations senior-first for a period.
    ///
    /// `tranches` must be sorted by strictly increasing priority (zero is
    /// senior). Unpaid amounts are carried by priority into the next call.
    /// The state is aggregate per bond and therefore does not grow with the
    /// number of investors. Holders can use `waterfall_claimable_for_holder`
    /// to pull their pro-rata share from the latest allocations.
    pub fn settle_waterfall(
        env: Env,
        caller: Address,
        bond_id: u64,
        tranches: Vec<WaterfallTranche>,
        carbon_available: i128,
        biodiversity_available: i128,
        nonce: u64,
    ) -> Result<WaterfallResult, BondError> {
        caller.require_auth();
        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);
        require_admin(&env, &caller)?;
        require_no_migration_window(&env, bond_id)?;

        if carbon_available < 0 || biodiversity_available < 0 {
            return Err(BondError::InvalidWaterfall);
        }
        validate_waterfall_tranches(&tranches)?;

        let previous: Vec<WaterfallTranche> = env
            .storage()
            .persistent()
            .get(&DataKey::WaterfallCarry(bond_id))
            .unwrap_or(vec![&env]);
        validate_waterfall_tranches(&previous)?;
        let obligations = merge_waterfall_tranches(&env, &previous, &tranches)?;
        if obligations.len() > MAX_WATERFALL_TRANCHES {
            return Err(BondError::InvalidWaterfall);
        }
        validate_waterfall_tranches(&obligations)?;

        let mut carbon_left = carbon_available;
        let mut biodiversity_left = biodiversity_available;
        let mut allocations = Vec::new(&env);
        let mut carry = Vec::new(&env);
        let bond_issuer: Address = env
            .storage()
            .instance()
            .get(&DataKey::BondIssuerAddress)
            .ok_or(BondError::NotInitialized)?;
        for obligation in obligations.iter() {
            let snapshot_version: u64 = env.invoke_contract(
                &bond_issuer,
                &Symbol::new(&env, "get_balance_version"),
                vec![&env, obligation.tranche_bond_id.into_val(&env)],
            );
            let carbon_paid = obligation.carbon_due.min(carbon_left);
            let biodiversity_paid = obligation.biodiversity_due.min(biodiversity_left);
            carbon_left = carbon_left
                .checked_sub(carbon_paid)
                .ok_or(BondError::Overflow)?;
            biodiversity_left = biodiversity_left
                .checked_sub(biodiversity_paid)
                .ok_or(BondError::Overflow)?;
            allocations.push_back(WaterfallAllocation {
                priority: obligation.priority,
                tranche_bond_id: obligation.tranche_bond_id,
                snapshot_version,
                carbon_due: obligation.carbon_due,
                carbon_paid,
                biodiversity_due: obligation.biodiversity_due,
                biodiversity_paid,
            });
            let carbon_unpaid = obligation
                .carbon_due
                .checked_sub(carbon_paid)
                .ok_or(BondError::Overflow)?;
            let biodiversity_unpaid = obligation
                .biodiversity_due
                .checked_sub(biodiversity_paid)
                .ok_or(BondError::Overflow)?;
            if carbon_unpaid > 0 || biodiversity_unpaid > 0 {
                carry.push_back(WaterfallTranche {
                    priority: obligation.priority,
                    tranche_bond_id: obligation.tranche_bond_id,
                    carbon_due: carbon_unpaid,
                    biodiversity_due: biodiversity_unpaid,
                });
            }
        }

        env.storage()
            .persistent()
            .set(&DataKey::WaterfallCarry(bond_id), &carry);
        env.storage()
            .persistent()
            .set(&DataKey::WaterfallAllocations(bond_id), &allocations);
        let settlement_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::WaterfallSettlementCount(bond_id))
            .unwrap_or(0);
        env.storage().persistent().set(
            &DataKey::WaterfallSettlementAllocations(bond_id, settlement_count),
            &allocations,
        );
        env.storage().persistent().set(
            &DataKey::WaterfallSettlementCount(bond_id),
            &settlement_count.checked_add(1).ok_or(BondError::Overflow)?,
        );
        env.events().publish(
            (Symbol::new(&env, "waterfall_settled"),),
            (
                bond_id,
                carbon_available - carbon_left,
                biodiversity_available - biodiversity_left,
            ),
        );

        Ok(WaterfallResult {
            allocations,
            carry,
            carbon_remaining: carbon_left,
            biodiversity_remaining: biodiversity_left,
        })
    }

    pub fn get_waterfall_carry(env: Env, bond_id: u64) -> Vec<WaterfallTranche> {
        env.storage()
            .persistent()
            .get(&DataKey::WaterfallCarry(bond_id))
            .unwrap_or(vec![&env])
    }

    pub fn get_waterfall_allocations(env: Env, bond_id: u64) -> Vec<WaterfallAllocation> {
        env.storage()
            .persistent()
            .get(&DataKey::WaterfallAllocations(bond_id))
            .unwrap_or(vec![&env])
    }

    pub fn get_waterfall_settlement_count(env: Env, bond_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::WaterfallSettlementCount(bond_id))
            .unwrap_or(0)
    }

    pub fn get_waterfall_settlement_allocations(
        env: Env,
        bond_id: u64,
        settlement_index: u32,
    ) -> Vec<WaterfallAllocation> {
        env.storage()
            .persistent()
            .get(&DataKey::WaterfallSettlementAllocations(
                bond_id,
                settlement_index,
            ))
            .unwrap_or(vec![&env])
    }

    /// Pull-based claim quote using a holder's snapshot balance. No holder
    /// state is stored by the waterfall; the caller supplies the tranche
    /// balance and total supply used for the settled period.
    pub fn waterfall_claimable_for_holder(
        env: Env,
        bond_id: u64,
        priority: u32,
        holder_balance: i128,
        tranche_supply: i128,
    ) -> Result<(i128, i128), BondError> {
        if holder_balance < 0 || tranche_supply <= 0 || holder_balance > tranche_supply {
            return Err(BondError::InvalidWaterfall);
        }
        let allocations: Vec<WaterfallAllocation> = Self::get_waterfall_allocations(env, bond_id);
        for allocation in allocations.iter() {
            if allocation.priority == priority {
                return Ok((
                    checked_ratio(allocation.carbon_paid, holder_balance, tranche_supply)?,
                    checked_ratio(allocation.biodiversity_paid, holder_balance, tranche_supply)?,
                ));
            }
        }
        Err(BondError::BondNotFound)
    }

    /// Pull-based claim quote using the bond issuer's canonical holder
    /// balance and subscribed supply captured at settlement. Use
    /// `claim_waterfall` to record the one-time claim in accrued balances.
    pub fn waterfall_claimable(
        env: Env,
        bond_id: u64,
        priority: u32,
        holder: Address,
    ) -> Result<(i128, i128), BondError> {
        let allocations: Vec<WaterfallAllocation> =
            Self::get_waterfall_allocations(env.clone(), bond_id);
        let allocation = allocations
            .iter()
            .find(|allocation| allocation.priority == priority)
            .ok_or(BondError::BondNotFound)?;
        let bond_issuer: Address = env
            .storage()
            .instance()
            .get(&DataKey::BondIssuerAddress)
            .ok_or(BondError::NotInitialized)?;
        let holder_balance: i128 = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "get_holder_balance_at_version"),
            vec![
                &env,
                allocation.tranche_bond_id.into_val(&env),
                holder.clone().into_val(&env),
                allocation.snapshot_version.into_val(&env),
            ],
        );
        let tranche_supply: i128 = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "total_subscribed_at_version"),
            vec![
                &env,
                allocation.tranche_bond_id.into_val(&env),
                allocation.snapshot_version.into_val(&env),
            ],
        );
        Self::waterfall_claimable_for_holder(env, bond_id, priority, holder_balance, tranche_supply)
    }

    /// Settle one holder's pro-rata waterfall allocation into the canonical
    /// accrued-credit ledger. A holder can claim each priority once per
    /// settlement; tranche ownership is read from the issuer, never supplied
    /// by the caller.
    pub fn claim_waterfall(
        env: Env,
        holder: Address,
        bond_id: u64,
        settlement_index: u32,
        priority: u32,
        nonce: u64,
    ) -> Result<(i128, i128), BondError> {
        holder.require_auth();
        let expected_nonce = get_nonce(&env, &holder);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(
            &env,
            &holder,
            expected_nonce.checked_add(1).ok_or(BondError::Overflow)?,
        );
        require_no_migration_window(&env, bond_id)?;

        let allocations =
            Self::get_waterfall_settlement_allocations(env.clone(), bond_id, settlement_index);
        let allocation = allocations
            .iter()
            .find(|allocation| allocation.priority == priority)
            .ok_or(BondError::BondNotFound)?;
        let claimed_key =
            DataKey::WaterfallClaimed(bond_id, settlement_index, priority, holder.clone());
        if env.storage().persistent().has(&claimed_key) {
            return Err(BondError::WaterfallAlreadyClaimed);
        }
        env.storage().persistent().set(&claimed_key, &true);

        let bond_issuer: Address = env
            .storage()
            .instance()
            .get(&DataKey::BondIssuerAddress)
            .ok_or(BondError::NotInitialized)?;
        let holder_balance: i128 = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "get_holder_balance_at_version"),
            vec![
                &env,
                allocation.tranche_bond_id.into_val(&env),
                holder.clone().into_val(&env),
                allocation.snapshot_version.into_val(&env),
            ],
        );
        let tranche_supply: i128 = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "total_subscribed_at_version"),
            vec![
                &env,
                allocation.tranche_bond_id.into_val(&env),
                allocation.snapshot_version.into_val(&env),
            ],
        );
        if holder_balance < 0 || tranche_supply <= 0 || holder_balance > tranche_supply {
            return Err(BondError::InvalidWaterfall);
        }
        let carbon = checked_ratio(allocation.carbon_paid, holder_balance, tranche_supply)?;
        let biodiversity =
            checked_ratio(allocation.biodiversity_paid, holder_balance, tranche_supply)?;
        accrue_waterfall_credit(&env, bond_id, &holder, CreditType::Carbon, carbon)?;
        accrue_waterfall_credit(
            &env,
            bond_id,
            &holder,
            CreditType::Biodiversity,
            biodiversity,
        )?;
        env.events().publish(
            (Symbol::new(&env, "waterfall_claimed"),),
            (
                bond_id,
                settlement_index,
                priority,
                holder,
                carbon,
                biodiversity,
            ),
        );
        Ok((carbon, biodiversity))
    }

    pub fn distribute_coupon(
        env: Env,
        caller: Address,
        bond_id: u64,
        period_index: u32,
        holders: Vec<Address>,
        report_id: u64,
        nonce: u64,
    ) -> Result<CouponResult, BondError> {
        let limit = holders.len();
        Self::distribute_coupon_batch(
            env,
            caller,
            bond_id,
            period_index,
            holders,
            report_id,
            0,
            limit,
            nonce,
        )
    }

    pub fn distribute_coupon_batch(
        env: Env,
        caller: Address,
        bond_id: u64,
        period_index: u32,
        holders: Vec<Address>,
        report_id: u64,
        offset: u32,
        limit: u32,
        nonce: u64,
    ) -> Result<CouponResult, BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        // Issue #188: pause coupon distribution while a migration window is
        // open for this bond.
        require_no_migration_window(&env, bond_id)?;

        let project_id: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::BondProject(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let oracle_consumer: Address = env
            .storage()
            .instance()
            .get(&DataKey::OracleConsumerAddress)
            .ok_or(BondError::NotInitialized)?;

        // Issue #193: Check if project is currently disputed & frozen
        let is_disputed: bool = env.invoke_contract(
            &oracle_consumer,
            &Symbol::new(&env, "is_project_disputed"),
            vec![&env, project_id.into_val(&env)],
        );
        if is_disputed {
            return Err(BondError::ProjectDisputedAndFrozen);
        }

        // Issue #192: Check oracle staleness state & graceful degradation
        let current_time = env.ledger().timestamp();
        let staleness_state: StalenessState = env.invoke_contract(
            &oracle_consumer,
            &Symbol::new(&env, "get_project_staleness_state"),
            vec![&env, project_id.into_val(&env), current_time.into_val(&env)],
        );
        if staleness_state.current_tier == 2 {
            return Err(BondError::OracleStaleManualInterventionRequired);
        }

        let report: Report = env.invoke_contract(
            &oracle_consumer,
            &Symbol::new(&env, "get_report"),
            vec![&env, report_id.into_val(&env)],
        );

        if report.status != ReportStatus::Verified {
            return Err(BondError::ReportNotVerified);
        }
        if report.project_id != project_id {
            return Err(BondError::BondNotFound);
        }

        // Issue #186: an active flag pauses automatic coupon distribution for
        // this bond until an admin clears it after dispute resolution — a
        // flagged update is never silently clamped.
        if env
            .storage()
            .instance()
            .has(&DataKey::PerformanceFlag(bond_id))
        {
            return Err(BondError::PerformanceFlagged);
        }

        // Issue #186: require a minimum number of independent attestations
        // before a report may drive payouts (mirrors the multi-source
        // guarantee in docs/oracle-design.md).
        let min_attestations: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MinPerformanceAttestations)
            .unwrap_or(MIN_PERFORMANCE_ATTESTATIONS);
        let attestation_count: u32 = env.invoke_contract(
            &oracle_consumer,
            &Symbol::new(&env, "get_verification_count"),
            vec![&env, report_id.into_val(&env)],
        );
        if attestation_count < min_attestations {
            return Err(BondError::InsufficientAttestations);
        }

        // Issue #186: bound the report against the trailing history before it
        // can affect any payout math.
        let is_flagged = validate_performance_update(
            &env,
            bond_id,
            report_id,
            period_index,
            report.carbon_sequestered,
        )?;
        if is_flagged {
            return Ok(CouponResult {
                bond_id,
                period_index,
                total_credits: 0,
                holder_count: 0,
                credits_per_token: 0,
            });
        }

        let existing: Option<PeriodInfo> = env
            .storage()
            .persistent()
            .get(&DataKey::PeriodInfo(bond_id, period_index));
        if let Some(ref info) = existing {
            if info.distributed {
                return Err(BondError::Overflow);
            }
            if info.report_id != report_id {
                return Err(BondError::InvalidReport);
            }
        }

        let bond_issuer: Address = env
            .storage()
            .instance()
            .get(&DataKey::BondIssuerAddress)
            .expect("bond issuer not set");

        let credit_type: CreditType = env
            .storage()
            .instance()
            .get(&DataKey::BondCreditType(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let carbon_total = report
            .carbon_sequestered
            .checked_div(CREDIT_DIVISOR)
            .ok_or(BondError::Overflow)?
            .checked_mul(CREDIT_MINOR_UNITS)
            .ok_or(BondError::Overflow)?;
        let (mut carbon_total, mut biodiversity_total) = match credit_type {
            CreditType::Carbon | CreditType::BlueCarbon => (carbon_total, 0),
            CreditType::Biodiversity => match report.biodiversity {
                BiodiversityMetrics::Absent => return Err(BondError::InvalidReport),
                ref metrics => (0, compute_biodiversity_credits(metrics)?),
            },
            CreditType::Basket => match report.biodiversity {
                BiodiversityMetrics::Absent => return Err(BondError::InvalidReport),
                ref metrics => (carbon_total, compute_biodiversity_credits(metrics)?),
            },
        };
        let mut total_credits = carbon_total
            .checked_add(biodiversity_total)
            .ok_or(BondError::Overflow)?;

        // Issue #192: Apply conservatism discount for Tier 1 staleness state
        if staleness_state.current_tier == 1 && staleness_state.discount_bps > 0 {
            let discount_multiplier = 10_000i128
                .checked_sub(staleness_state.discount_bps as i128)
                .ok_or(BondError::Overflow)?;
            carbon_total = checked_ratio(carbon_total, discount_multiplier, 10_000)?;
            biodiversity_total = checked_ratio(biodiversity_total, discount_multiplier, 10_000)?;
            total_credits = carbon_total
                .checked_add(biodiversity_total)
                .ok_or(BondError::Overflow)?;
        }

        // Issue #194: Incorporate unapplied CarbonChain true-up adjustments forward without clawback
        if offset == 0 && existing.is_none() {
            let true_up_count: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::TrueUpCount(bond_id))
                .unwrap_or(0);
            let mut accumulated_true_up: i128 = 0;
            for i in 0..true_up_count {
                if let Some(mut adj) = env
                    .storage()
                    .persistent()
                    .get::<_, TrueUpAdjustment>(&DataKey::TrueUpAdjustment(bond_id, i))
                {
                    if !adj.applied {
                        accumulated_true_up = accumulated_true_up
                            .checked_add(adj.adjustment_amount)
                            .ok_or(BondError::Overflow)?;
                        adj.applied = true;
                        env.storage()
                            .persistent()
                            .set(&DataKey::TrueUpAdjustment(bond_id, i), &adj);
                    }
                }
            }
            if accumulated_true_up != 0 {
                let adjusted_pool = if credit_type == CreditType::Biodiversity {
                    &mut biodiversity_total
                } else {
                    &mut carbon_total
                };
                *adjusted_pool = adjusted_pool
                    .checked_add(accumulated_true_up)
                    .ok_or(BondError::Overflow)?
                    .max(0);
                total_credits = carbon_total
                    .checked_add(biodiversity_total)
                    .ok_or(BondError::Overflow)?;
            }
        }
        if total_credits > MAX_COUPON_POOL {
            return Err(BondError::Overflow);
        }

        let total_subscribed: i128 = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "total_subscribed"),
            vec![&env, bond_id.into_val(&env)],
        );

        let mut total_holder_credits: i128 = 0;
        let mut holder_count: u32 = 0;

        let holder_len = holders.len();
        if limit > MAX_COUPON_BATCH_SIZE || offset > holder_len {
            return Err(BondError::Overflow);
        }
        let end = offset.checked_add(limit).ok_or(BondError::Overflow)?;
        if end > holder_len {
            return Err(BondError::Overflow);
        }
        let cursor: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::PeriodBatchCursor(bond_id, period_index))
            .unwrap_or(0);
        if offset != cursor {
            return Err(BondError::Overflow);
        }

        let mut i = offset;
        while i < end {
            let holder = holders.get(i).ok_or(BondError::Overflow)?;
            if appears_before(&holders, &holder, i) {
                return Err(BondError::Overflow);
            }

            let balance: i128 = env.invoke_contract(
                &bond_issuer,
                &Symbol::new(&env, "get_holder_balance"),
                vec![&env, bond_id.into_val(&env), holder.clone().into_val(&env)],
            );

            if balance > 0 {
                match credit_type {
                    CreditType::Carbon | CreditType::BlueCarbon => {
                        let holder_credits =
                            checked_ratio(total_credits, balance, total_subscribed)?;
                        if holder_credits > 0 {
                            total_holder_credits = total_holder_credits
                                .checked_add(holder_credits)
                                .ok_or(BondError::Overflow)?;
                            escrow_credits(
                                &env,
                                bond_id,
                                period_index,
                                holder.clone(),
                                CreditType::Carbon,
                                holder_credits,
                            )?;
                            holder_count += 1;
                        }
                    }
                    CreditType::Biodiversity => {
                        let holder_credits =
                            checked_ratio(total_credits, balance, total_subscribed)?;
                        if holder_credits > 0 {
                            total_holder_credits = total_holder_credits
                                .checked_add(holder_credits)
                                .ok_or(BondError::Overflow)?;
                            escrow_credits(
                                &env,
                                bond_id,
                                period_index,
                                holder.clone(),
                                CreditType::Biodiversity,
                                holder_credits,
                            )?;
                            holder_count += 1;
                        }
                    }
                    CreditType::Basket => {
                        let carbon_holder = checked_ratio(carbon_total, balance, total_subscribed)?;
                        let biodiversity_holder =
                            checked_ratio(biodiversity_total, balance, total_subscribed)?;
                        let holder_credits = carbon_holder
                            .checked_add(biodiversity_holder)
                            .ok_or(BondError::Overflow)?;
                        if holder_credits > 0 {
                            total_holder_credits = total_holder_credits
                                .checked_add(holder_credits)
                                .ok_or(BondError::Overflow)?;
                            if carbon_holder > 0 {
                                escrow_credits(
                                    &env,
                                    bond_id,
                                    period_index,
                                    holder.clone(),
                                    CreditType::Carbon,
                                    carbon_holder,
                                )?;
                            }
                            if biodiversity_holder > 0 {
                                escrow_credits(
                                    &env,
                                    bond_id,
                                    period_index,
                                    holder.clone(),
                                    CreditType::Biodiversity,
                                    biodiversity_holder,
                                )?;
                            }
                            holder_count += 1;
                        }
                    }
                }
            }
            i += 1;
        }

        let previous_credits = existing
            .as_ref()
            .map(|info| info.total_credits_earned)
            .unwrap_or(0);
        let cumulative_holder_credits = previous_credits
            .checked_add(total_holder_credits)
            .ok_or(BondError::Overflow)?;
        let batch_complete = end == holder_len;
        let undistributed = if batch_complete {
            total_credits
                .checked_sub(cumulative_holder_credits)
                .ok_or(BondError::Overflow)?
        } else {
            0
        };

        let period_info = PeriodInfo {
            period_index,
            start_time: report.period_start,
            end_time: report.period_end,
            total_credits_earned: cumulative_holder_credits,
            distributed: batch_complete,
            report_id,
            undistributed,
        };
        env.storage()
            .persistent()
            .set(&DataKey::PeriodInfo(bond_id, period_index), &period_info);
        env.storage()
            .persistent()
            .set(&DataKey::PeriodBatchCursor(bond_id, period_index), &end);

        if batch_complete && period_info.undistributed > 0 {
            let undistributed_total: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::UndistributedTotal(bond_id))
                .unwrap_or(0);
            let new_total = undistributed_total
                .checked_add(period_info.undistributed)
                .ok_or(BondError::Overflow)?;
            env.storage()
                .persistent()
                .set(&DataKey::UndistributedTotal(bond_id), &new_total);
        }

        if batch_complete {
            let count: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::PeriodCount(bond_id))
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(&DataKey::PeriodCount(bond_id), &(count + 1));

            // Issue #186: record the accepted performance observation in the
            // trailing history used by future rate-of-change checks.
            append_performance_record(
                &env,
                bond_id,
                period_index,
                report_id,
                report.carbon_sequestered,
            );
        }

        env.events().publish(
            (Symbol::new(&env, "coupon_distributed"),),
            (bond_id, period_index, total_holder_credits, holder_count),
        );

        Ok(CouponResult {
            bond_id,
            period_index,
            total_credits: cumulative_holder_credits,
            holder_count,
            credits_per_token,
        })
    }

    
    pub fn confirm_retirement(
        env: Env,
        caller: Address,
        bond_id: u64,
        holder: Address,
        amount: i128,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();
        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);
        require_admin(&env, &caller)?;

        let key = DataKey::EscrowedCredits(bond_id, holder.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount > current {
            return Err(BondError::Overflow);
        }
        env.storage().persistent().set(&key, &(current - amount));

        Ok(())
    }

    pub fn revert_payout(
        env: Env,
        caller: Address,
        bond_id: u64,
        holder: Address,
        amount: i128,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();
        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);
        require_admin(&env, &caller)?;

        let key = DataKey::EscrowedCredits(bond_id, holder.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount > current {
            return Err(BondError::Overflow);
        }
        env.storage().persistent().set(&key, &(current - amount));
        
        Ok(())
    }

    pub fn escrowed_credits(env: Env, bond_id: u64, holder: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::EscrowedCredits(bond_id, holder))
            .unwrap_or(0)
    }

    pub fn escrowed_credits_by_type(
        env: Env,
        bond_id: u64,
        holder: Address,
        credit_type: CreditType,
    ) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::EscrowedCreditsByType(bond_id, holder, credit_type))
            .unwrap_or(0)
    }

    /// Total claimable coupons for a holder on a bond, in minor units (#156).
    pub fn claimable_credits(env: Env, bond_id: u64, holder: Address) -> i128 {
        Self::escrowed_credits(env, bond_id, holder)
    }

    /// Itemized claimable coupons for a holder on a bond (#156). One entry per
    /// (period, credit type) with the underlying report id and period window.
    pub fn claimable_credit_details(
        env: Env,
        bond_id: u64,
        holder: Address,
    ) -> Vec<ClaimableCreditDetail> {
        let period_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::PeriodCount(bond_id))
            .unwrap_or(0);
        let mut details: Vec<ClaimableCreditDetail> = Vec::new(&env);
        for period_index in 0..period_count {
            for credit_type in [CreditType::Carbon, CreditType::Biodiversity] {
                let amount: i128 = env
                    .storage()
                    .persistent()
                    .get(&DataKey::PeriodHolder(
                        bond_id,
                        period_index,
                        holder.clone(),
                        credit_type,
                    ))
                    .unwrap_or(0);
                if amount <= 0 {
                    continue;
                }
                let info: Option<PeriodInfo> = env
                    .storage()
                    .persistent()
                    .get(&DataKey::PeriodInfo(bond_id, period_index));
                if let Some(info) = info {
                    details.push_back(ClaimableCreditDetail {
                        period_index,
                        report_id: info.report_id,
                        start_time: info.start_time,
                        end_time: info.end_time,
                        credit_type,
                        amount,
                    });
                }
            }
        }
        details
    }

    pub fn get_bond_credit_type(env: Env, bond_id: u64) -> Result<CreditType, BondError> {
        env.storage()
            .instance()
            .get(&DataKey::BondCreditType(bond_id))
            .ok_or(BondError::BondNotFound)
    }

    pub fn claim_credits(
        env: Env,
        caller: Address,
        bond_id: u64,
        nonce: u64,
    ) -> Result<i128, BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        // Issue #188: claims are paused while a migration window is open.
        require_no_migration_window(&env, bond_id)?;

        let key = DataKey::EscrowedCredits(bond_id, caller.clone());
        let accrued: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &0i128);

        if accrued > 0 {
            clear_accrued(&env, bond_id, &caller, CreditType::Carbon);
            clear_accrued(&env, bond_id, &caller, CreditType::Biodiversity);

            let period_count: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::PeriodCount(bond_id))
                .unwrap_or(0);
            for period_index in 0..period_count {
                clear_period_holder(&env, bond_id, period_index, &caller, CreditType::Carbon);
                clear_period_holder(
                    &env,
                    bond_id,
                    period_index,
                    &caller,
                    CreditType::Biodiversity,
                );
            }
            env.storage().persistent().set(
                &DataKey::WaterfallAccrued(bond_id, caller.clone(), CreditType::Carbon),
                &0i128,
            );
            env.storage().persistent().set(
                &DataKey::WaterfallAccrued(bond_id, caller.clone(), CreditType::Biodiversity),
                &0i128,
            );
        }

        env.events().publish(
            (Symbol::new(&env, "credits_claimed"),),
            (bond_id, caller, accrued),
        );

        Ok(accrued)
    }

    /// Debits `amount` minor units from `holder`'s accrued balance on
    /// `bond_id`. This is the settlement hook behind `retire_credits`: the
    /// retirement contract calls it before minting a certificate, so credits
    /// that have been retired can never also be withdrawn through
    /// `claim_credits`. The holder authorizes the call as a sub-invocation of
    /// `retire_credits`, which already consumed their nonce there, so none is
    /// taken here. Per-period and per-type entries are drained oldest-first
    /// so the itemized provenance view keeps matching the combined balance.
    pub fn consume_credits(
        env: Env,
        holder: Address,
        bond_id: u64,
        amount: i128,
    ) -> Result<(), BondError> {
        holder.require_auth();

        if amount <= 0 {
            return Err(BondError::ZeroAmount);
        }

        // Issue #188: consumption is paused while a migration window is open.
        require_no_migration_window(&env, bond_id)?;

        let key = DataKey::EscrowedCredits(bond_id, holder.clone());
        let accrued: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount > accrued {
            return Err(BondError::Overflow);
        }
        env.storage().persistent().set(&key, &(accrued - amount));

        let period_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::PeriodCount(bond_id))
            .unwrap_or(0);
        let mut left = amount;
        for period_index in 0..period_count {
            for credit_type in [CreditType::Carbon, CreditType::Biodiversity] {
                if left == 0 {
                    break;
                }
                let period_key =
                    DataKey::PeriodHolder(bond_id, period_index, holder.clone(), credit_type);
                let entry: i128 = env.storage().persistent().get(&period_key).unwrap_or(0);
                if entry <= 0 {
                    continue;
                }
                let take = entry.min(left);
                env.storage().persistent().set(&period_key, &(entry - take));

                let by_type_key =
                    DataKey::EscrowedCreditsByType(bond_id, holder.clone(), credit_type);
                let by_type: i128 = env.storage().persistent().get(&by_type_key).unwrap_or(0);
                env.storage().persistent().set(
                    &by_type_key,
                    &by_type.checked_sub(take).ok_or(BondError::Overflow)?,
                );
                left -= take;
            }
        }
        for credit_type in [CreditType::Carbon, CreditType::Biodiversity] {
            if left == 0 {
                break;
            }
            let waterfall_key = DataKey::WaterfallAccrued(bond_id, holder.clone(), credit_type);
            let entry: i128 = env.storage().persistent().get(&waterfall_key).unwrap_or(0);
            if entry <= 0 {
                continue;
            }
            let take = entry.min(left);
            env.storage()
                .persistent()
                .set(&waterfall_key, &(entry - take));

            let by_type_key = DataKey::AccruedCreditsByType(bond_id, holder.clone(), credit_type);
            let by_type: i128 = env.storage().persistent().get(&by_type_key).unwrap_or(0);
            env.storage().persistent().set(
                &by_type_key,
                &by_type.checked_sub(take).ok_or(BondError::Overflow)?,
            );
            left -= take;
        }
        if left != 0 {
            return Err(BondError::Overflow);
        }

        env.events().publish(
            (Symbol::new(&env, "credits_consumed"),),
            (bond_id, holder, amount),
        );

        Ok(())
    }

    pub fn get_period_info(
        env: Env,
        bond_id: u64,
        period_index: u32,
    ) -> Result<PeriodInfo, BondError> {
        env.storage()
            .persistent()
            .get(&DataKey::PeriodInfo(bond_id, period_index))
            .ok_or(BondError::BondNotFound)
    }

    pub fn get_period_count(env: Env, bond_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::PeriodCount(bond_id))
            .unwrap_or(0)
    }

    pub fn get_undistributed_total(env: Env, bond_id: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::UndistributedTotal(bond_id))
            .unwrap_or(0)
    }

    pub fn sweep_undistributed(
        env: Env,
        caller: Address,
        bond_id: u64,
        nonce: u64,
    ) -> Result<i128, BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        let key = DataKey::UndistributedTotal(bond_id);
        let total: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &0i128);

        env.events().publish(
            (Symbol::new(&env, "undistributed_swept"),),
            (bond_id, total),
        );

        Ok(total)
    }

    pub fn set_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
        nonce: u64,
    ) -> Result<(), BondError> {
        current_admin.require_auth();

        let expected_nonce = get_nonce(&env, &current_admin);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &current_admin, expected_nonce + 1);

        require_admin(&env, &current_admin)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (Symbol::new(&env, "admin_changed"),),
            (current_admin, new_admin),
        );

        Ok(())
    }

    pub fn get_admin(env: Env) -> Result<Address, BondError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(BondError::NotInitialized)
    }

    /// Issue #186: minimum independent attestations a report needs before it
    /// may drive coupon payouts.
    pub fn get_min_performance_attestations(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MinPerformanceAttestations)
            .unwrap_or(MIN_PERFORMANCE_ATTESTATIONS)
    }

    /// Issue #186: admin override for the coupon-level attestation minimum.
    pub fn set_min_performance_attestations(
        env: Env,
        caller: Address,
        min_attestations: u32,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;
        if min_attestations == 0 {
            return Err(BondError::ZeroAmount);
        }

        env.storage()
            .instance()
            .set(&DataKey::MinPerformanceAttestations, &min_attestations);
        env.events().publish(
            (Symbol::new(&env, "min_attestations_changed"),),
            (min_attestations,),
        );

        Ok(())
    }

    /// Issue #186: whether an out-of-bound performance update is currently
    /// pausing coupon distribution for this bond.
    pub fn is_performance_flagged(env: Env, bond_id: u64) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::PerformanceFlag(bond_id))
    }

    /// Issue #186: details of the active performance flag, if any.
    pub fn get_performance_flag(env: Env, bond_id: u64) -> Option<PerformanceFlag> {
        env.storage()
            .instance()
            .get(&DataKey::PerformanceFlag(bond_id))
    }

    /// Issue #186: trailing verified performance observations (oldest first).
    pub fn get_performance_history(env: Env, bond_id: u64) -> Vec<PerformanceRecord> {
        env.storage()
            .instance()
            .get(&DataKey::PerformanceHistory(bond_id))
            .unwrap_or(vec![&env])
    }

    /// Issue #186: clear the performance flag after the dispute mechanism has
    /// reviewed it, resuming automatic coupon distribution for the bond.
    pub fn clear_performance_flag(
        env: Env,
        caller: Address,
        bond_id: u64,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        if !env
            .storage()
            .instance()
            .has(&DataKey::PerformanceFlag(bond_id))
        {
            return Err(BondError::BondNotFound);
        }

        env.storage()
            .instance()
            .remove(&DataKey::PerformanceFlag(bond_id));
        env.events()
            .publish((Symbol::new(&env, "performance_unflagged"),), (bond_id,));

        Ok(())
    }

    // ── Migration window (issue #188) ────────────────────────────────────────

    /// Issue #188: whether a migration window is open for this bond.
    pub fn get_migration_window(env: Env, bond_id: u64) -> Option<MigrationWindow> {
        env.storage()
            .instance()
            .get(&DataKey::MigrationWindow(bond_id))
    }

    /// Issue #188: open a migration window for a bond. Coupon distribution,
    /// claims and consumption are paused and the in-flight state
    /// (undistributed total, period count) is snapshotted so a rollback can
    /// prove nothing was lost or double-processed.
    pub fn begin_migration(
        env: Env,
        caller: Address,
        bond_id: u64,
        nonce: u64,
    ) -> Result<MigrationWindow, BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        if env
            .storage()
            .instance()
            .has(&DataKey::MigrationWindow(bond_id))
        {
            return Err(BondError::Overflow);
        }

        let window = MigrationWindow {
            started_at: env.ledger().timestamp(),
            snapshot_undistributed: env
                .storage()
                .persistent()
                .get(&DataKey::UndistributedTotal(bond_id))
                .unwrap_or(0),
            snapshot_period_count: env
                .storage()
                .persistent()
                .get(&DataKey::PeriodCount(bond_id))
                .unwrap_or(0),
        };
        env.storage()
            .instance()
            .set(&DataKey::MigrationWindow(bond_id), &window);
        env.events()
            .publish((Symbol::new(&env, "migration_started"),), (bond_id,));

        Ok(window)
    }

    /// Issue #188: close the migration window after the upgrade succeeded,
    /// resuming normal coupon flow.
    pub fn finalize_migration(
        env: Env,
        caller: Address,
        bond_id: u64,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        if !env
            .storage()
            .instance()
            .has(&DataKey::MigrationWindow(bond_id))
        {
            return Err(BondError::BondNotFound);
        }

        env.storage()
            .instance()
            .remove(&DataKey::MigrationWindow(bond_id));
        env.events()
            .publish((Symbol::new(&env, "migration_finalized"),), (bond_id,));

        Ok(())
    }

    /// Issue #188: abort an open migration window and prove the in-flight
    /// state was preserved: the snapshot taken at `begin_migration` must
    /// still match the live undistributed total and period count (writes are
    /// paused while the window is open, so a mismatch means tampering).
    /// Returns the restored snapshot on success.
    pub fn rollback_migration(
        env: Env,
        caller: Address,
        bond_id: u64,
        nonce: u64,
    ) -> Result<MigrationWindow, BondError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(BondError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        let window: MigrationWindow = env
            .storage()
            .instance()
            .get(&DataKey::MigrationWindow(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let live_undistributed: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::UndistributedTotal(bond_id))
            .unwrap_or(0);
        let live_period_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::PeriodCount(bond_id))
            .unwrap_or(0);

        if live_undistributed != window.snapshot_undistributed
            || live_period_count != window.snapshot_period_count
        {
            return Err(BondError::Overflow);
        }

        env.storage()
            .instance()
            .remove(&DataKey::MigrationWindow(bond_id));
        env.events()
            .publish((Symbol::new(&env, "migration_rolled_back"),), (bond_id,));

        Ok(window)
    }

    /// Issue #188: versioned-interface convention — bump when the contract's
    /// storage layout or callable interface changes in a breaking way. See
    /// docs/upgrade-migrations.md.
    pub fn schema_version(env: Env) -> u32 {
        let _ = env;
        SCHEMA_VERSION
    }
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), BondError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(BondError::NotInitialized)?;
    if caller != &admin {
        return Err(BondError::Unauthorized);
    }
    Ok(())
}

fn get_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::Nonce(addr.clone()))
        .unwrap_or(0)
}

fn set_nonce(env: &Env, addr: &Address, nonce: u64) {
    env.storage()
        .persistent()
        .set(&DataKey::Nonce(addr.clone()), &nonce);
}

fn compute_biodiversity_credits(metrics: &BiodiversityMetrics) -> Result<i128, BondError> {
    let (habitat, species, units) = match metrics {
        BiodiversityMetrics::Absent => return Ok(0),
        BiodiversityMetrics::Present(v) => *v,
    };
    if habitat < 0 || species < 0 || units < 0 {
        return Err(BondError::InvalidReport);
    }
    habitat
        .checked_mul(HABITAT_CREDIT_RATE)
        .ok_or(BondError::Overflow)?
        .checked_add(
            species
                .checked_mul(SPECIES_CREDIT_RATE)
                .ok_or(BondError::Overflow)?,
        )
        .ok_or(BondError::Overflow)?
        .checked_add(
            units
                .checked_mul(UNIT_CREDIT_RATE)
                .ok_or(BondError::Overflow)?,
        )
        .ok_or(BondError::Overflow)?
        .checked_mul(CREDIT_MINOR_UNITS)
        .ok_or(BondError::Overflow)?
        .checked_div(HABITAT_CREDIT_RATE)
        .ok_or(BondError::Overflow)
}

fn escrow_credits(
    env: &Env,
    bond_id: u64,
    period_index: u32,
    holder: Address,
    credit_type: CreditType,
    amount: i128,
) -> Result<(), BondError> {
    let by_type_key = DataKey::EscrowedCreditsByType(bond_id, holder.clone(), credit_type);
    let by_type: i128 = env.storage().persistent().get(&by_type_key).unwrap_or(0);
    env.storage().persistent().set(
        &by_type_key,
        &by_type.checked_add(amount).ok_or(BondError::Overflow)?,
    );

    let period_key = DataKey::PeriodHolder(bond_id, period_index, holder.clone(), credit_type);
    let period_amount: i128 = env.storage().persistent().get(&period_key).unwrap_or(0);
    env.storage().persistent().set(
        &period_key,
        &period_amount
            .checked_add(amount)
            .ok_or(BondError::Overflow)?,
    );

    let combined_key = DataKey::EscrowedCredits(bond_id, holder);
    let combined: i128 = env.storage().persistent().get(&combined_key).unwrap_or(0);
    env.storage().persistent().set(
        &combined_key,
        &combined.checked_add(amount).ok_or(BondError::Overflow)?,
    );
    Ok(())
}

fn accrue_waterfall_credit(
    env: &Env,
    bond_id: u64,
    holder: &Address,
    credit_type: CreditType,
    amount: i128,
) -> Result<(), BondError> {
    if amount == 0 {
        return Ok(());
    }
    let by_type_key = DataKey::AccruedCreditsByType(bond_id, holder.clone(), credit_type);
    let by_type: i128 = env.storage().persistent().get(&by_type_key).unwrap_or(0);
    env.storage().persistent().set(
        &by_type_key,
        &by_type.checked_add(amount).ok_or(BondError::Overflow)?,
    );

    let combined_key = DataKey::AccruedCredits(bond_id, holder.clone());
    let combined: i128 = env.storage().persistent().get(&combined_key).unwrap_or(0);
    env.storage().persistent().set(
        &combined_key,
        &combined.checked_add(amount).ok_or(BondError::Overflow)?,
    );

    let waterfall_key = DataKey::WaterfallAccrued(bond_id, holder.clone(), credit_type);
    let waterfall_amount: i128 = env.storage().persistent().get(&waterfall_key).unwrap_or(0);
    env.storage().persistent().set(
        &waterfall_key,
        &waterfall_amount
            .checked_add(amount)
            .ok_or(BondError::Overflow)?,
    );
    Ok(())
}

fn clear_period_holder(
    env: &Env,
    bond_id: u64,
    period_index: u32,
    holder: &Address,
    credit_type: CreditType,
) {
    let key = DataKey::PeriodHolder(bond_id, period_index, holder.clone(), credit_type);
    env.storage().persistent().set(&key, &0i128);
}

fn clear_accrued(env: &Env, bond_id: u64, holder: &Address, credit_type: CreditType) {
    let key = DataKey::EscrowedCreditsByType(bond_id, holder.clone(), credit_type);
    env.storage().persistent().set(&key, &0i128);
}

fn checked_ratio(value: i128, multiplier: i128, divisor: i128) -> Result<i128, BondError> {
    if divisor <= 0 {
        return Err(BondError::Overflow);
    }
    value
        .checked_mul(multiplier)
        .ok_or(BondError::Overflow)?
        .checked_div(divisor)
        .ok_or(BondError::Overflow)
}

fn validate_waterfall_tranches(tranches: &Vec<WaterfallTranche>) -> Result<(), BondError> {
    if tranches.len() > MAX_WATERFALL_TRANCHES {
        return Err(BondError::InvalidWaterfall);
    }
    let mut previous: Option<u32> = None;
    let mut index = 0;
    for tranche in tranches.iter() {
        if tranche.tranche_bond_id == 0 || tranche.carbon_due < 0 || tranche.biodiversity_due < 0 {
            return Err(BondError::InvalidWaterfall);
        }
        if let Some(priority) = previous {
            if tranche.priority <= priority {
                return Err(BondError::InvalidWaterfall);
            }
        }
        for previous_index in 0..index {
            if tranches
                .get(previous_index)
                .ok_or(BondError::InvalidWaterfall)?
                .tranche_bond_id
                == tranche.tranche_bond_id
            {
                return Err(BondError::InvalidWaterfall);
            }
        }
        previous = Some(tranche.priority);
        index += 1;
    }
    Ok(())
}

fn merge_waterfall_tranches(
    env: &Env,
    carry: &Vec<WaterfallTranche>,
    current: &Vec<WaterfallTranche>,
) -> Result<Vec<WaterfallTranche>, BondError> {
    let mut merged = Vec::new(env);
    let mut carry_index = 0;
    let mut current_index = 0;
    while carry_index < carry.len() || current_index < current.len() {
        let carry_item = carry.get(carry_index);
        let current_item = current.get(current_index);
        match (carry_item, current_item) {
            (Some(old), Some(new)) if old.priority == new.priority => {
                if old.tranche_bond_id != new.tranche_bond_id {
                    return Err(BondError::InvalidWaterfall);
                }
                merged.push_back(WaterfallTranche {
                    priority: old.priority,
                    tranche_bond_id: old.tranche_bond_id,
                    carbon_due: old
                        .carbon_due
                        .checked_add(new.carbon_due)
                        .ok_or(BondError::Overflow)?,
                    biodiversity_due: old
                        .biodiversity_due
                        .checked_add(new.biodiversity_due)
                        .ok_or(BondError::Overflow)?,
                });
                carry_index += 1;
                current_index += 1;
            }
            (Some(old), Some(new)) if old.priority < new.priority => {
                merged.push_back(old);
                carry_index += 1;
            }
            (Some(_), Some(_)) => {
                merged.push_back(current.get(current_index).ok_or(BondError::Overflow)?);
                current_index += 1;
            }
            (Some(old), None) => {
                merged.push_back(old);
                carry_index += 1;
            }
            (None, Some(new)) => {
                merged.push_back(new);
                current_index += 1;
            }
            (None, None) => break,
        }
    }
    Ok(merged)
}

/// Issue #188: coupon writes for a bond with an open migration window are
/// paused so in-flight state cannot be mutated mid-cutover.
fn require_no_migration_window(env: &Env, bond_id: u64) -> Result<(), BondError> {
    if env
        .storage()
        .instance()
        .has(&DataKey::MigrationWindow(bond_id))
    {
        return Err(BondError::MigrationInProgress);
    }
    Ok(())
}

/// Issue #186: bound a report's performance against the trailing history.
///
/// The first accepted observation is the baseline (nothing to compare yet).
/// Afterwards, an increase beyond `MAX_PERFORMANCE_INCREASE_BPS` or a drop
/// beyond `MAX_PERFORMANCE_DECREASE_BPS` sets a `PerformanceFlag` — which
/// pauses coupon distribution for the bond until an admin clears it after
/// dispute resolution — and the update is rejected, never silently clamped.
fn validate_performance_update(
    env: &Env,
    bond_id: u64,
    report_id: u64,
    _period_index: u32,
    carbon_sequestered: i128,
) -> Result<bool, BondError> {
    let history: Vec<PerformanceRecord> = env
        .storage()
        .instance()
        .get(&DataKey::PerformanceHistory(bond_id))
        .unwrap_or(vec![env]);
    let previous = match history.len() {
        0 => return Ok(false), // no history yet: this observation is the baseline
        len => history.get(len - 1).ok_or(BondError::Overflow)?,
    };

    if previous.carbon_sequestered <= 0 {
        // A non-positive baseline cannot bound a ratio; accept the update.
        return Ok(false);
    }

    let reason = if carbon_sequestered > previous.carbon_sequestered {
        let delta = carbon_sequestered - previous.carbon_sequestered;
        let increase_bps = delta
            .checked_mul(10_000)
            .ok_or(BondError::Overflow)?
            .checked_div(previous.carbon_sequestered)
            .ok_or(BondError::Overflow)?;
        if increase_bps <= MAX_PERFORMANCE_INCREASE_BPS {
            return Ok(false);
        }
        PerformanceAnomaly::Spike
    } else if carbon_sequestered < previous.carbon_sequestered {
        let drop = previous.carbon_sequestered - carbon_sequestered;
        let drop_bps = drop
            .checked_mul(10_000)
            .ok_or(BondError::Overflow)?
            .checked_div(previous.carbon_sequestered)
            .ok_or(BondError::Overflow)?;
        if drop_bps <= MAX_PERFORMANCE_DECREASE_BPS {
            return Ok(false);
        }
        PerformanceAnomaly::Drop
    } else {
        return Ok(false);
    };

    env.storage().instance().set(
        &DataKey::PerformanceFlag(bond_id),
        &PerformanceFlag {
            report_id,
            reason,
            previous_value: previous.carbon_sequestered,
            reported_value: carbon_sequestered,
            flagged_at: env.ledger().timestamp(),
        },
    );
    env.events().publish(
        (Symbol::new(env, "performance_flagged"),),
        (bond_id, report_id),
    );

    Ok(true)
}

/// Issue #186: append an accepted observation to the trailing history,
/// keeping at most `TRAILING_HISTORY_PERIODS` records.
fn append_performance_record(
    env: &Env,
    bond_id: u64,
    period_index: u32,
    report_id: u64,
    carbon_sequestered: i128,
) {
    let mut history: Vec<PerformanceRecord> = env
        .storage()
        .instance()
        .get(&DataKey::PerformanceHistory(bond_id))
        .unwrap_or(vec![env]);
    history.push_back(PerformanceRecord {
        period_index,
        report_id,
        carbon_sequestered,
    });
    while history.len() > TRAILING_HISTORY_PERIODS {
        history.pop_front();
    }
    env.storage()
        .instance()
        .set(&DataKey::PerformanceHistory(bond_id), &history);
}

fn appears_before(holders: &Vec<Address>, holder: &Address, end_exclusive: u32) -> bool {
    let mut i = 0;
    while i < end_exclusive {
        if let Some(previous) = holders.get(i) {
            if previous == *holder {
                return true;
            }
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, vec, BytesN, Env, Symbol};

    #[test]
    fn biodiversity_credit_math_rejects_negative_and_overflowing_values() {
        assert_eq!(
            compute_biodiversity_credits(&BiodiversityMetrics::Absent),
            Ok(0)
        );
        assert_eq!(
            compute_biodiversity_credits(&BiodiversityMetrics::Present((-1, 0, 0))),
            Err(BondError::InvalidReport)
        );
        assert_eq!(
            compute_biodiversity_credits(&BiodiversityMetrics::Present((i128::MAX, 0, 0))),
            Err(BondError::Overflow)
        );
    }

    fn waterfall_tranches(env: &Env, due: i128, bond_ids: [u64; 3]) -> Vec<WaterfallTranche> {
        vec![
            env,
            WaterfallTranche {
                priority: 0,
                tranche_bond_id: bond_ids[0],
                carbon_due: due,
                biodiversity_due: due,
            },
            WaterfallTranche {
                priority: 1,
                tranche_bond_id: bond_ids[1],
                carbon_due: due,
                biodiversity_due: due,
            },
            WaterfallTranche {
                priority: 2,
                tranche_bond_id: bond_ids[2],
                carbon_due: due,
                biodiversity_due: due,
            },
        ]
    }

    #[test]
    fn test_waterfall_full_partial_total_and_carry_forward() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let t = deploy(env, admin);
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
        let mut bond_ids = [0u64; 3];
        for index in 0..3 {
            let holder = Address::generate(&t._env);
            let project_id = create_project_id(&t._env, index as u8 + 1);
            let config = make_bond_config(&t._env, &project_id);
            bond_ids[index as usize] = issuer.issue_bond(&t.issuer_admin, &config, &(index as u64));
            issuer.subscribe(&holder, &bond_ids[index as usize], &1_000, &0);
        }

        let full = t.client.settle_waterfall(
            &t.admin,
            &1,
            &waterfall_tranches(&t._env, 100, bond_ids),
            &300,
            &600,
            &0,
        );
        assert_eq!(full.carry.len(), 0);
        assert_eq!(full.allocations.get(0).unwrap().carbon_paid, 100);
        assert_eq!(full.allocations.get(2).unwrap().biodiversity_paid, 100);
        assert_eq!(full.biodiversity_remaining, 300);
        assert_eq!(
            t.client
                .waterfall_claimable_for_holder(&1, &0, &1, &2)
                .unwrap(),
            (50, 50)
        );

        let partial = t.client.settle_waterfall(
            &t.admin,
            &1,
            &waterfall_tranches(&t._env, 100, bond_ids),
            &150,
            &0,
            &1,
        );
        assert_eq!(partial.allocations.get(0).unwrap().carbon_paid, 100);
        assert_eq!(partial.allocations.get(1).unwrap().carbon_paid, 50);
        assert_eq!(partial.allocations.get(2).unwrap().carbon_paid, 0);
        assert_eq!(partial.carry.get(0).unwrap().carbon_due, 50);

        let total = t.client.settle_waterfall(
            &t.admin,
            &1,
            &waterfall_tranches(&t._env, 100, bond_ids),
            &0,
            &0,
            &2,
        );
        assert_eq!(total.allocations.get(0).unwrap().carbon_paid, 0);
        assert_eq!(total.carry.get(0).unwrap().carbon_due, 150);
        assert_eq!(total.carry.get(1).unwrap().carbon_due, 200);

        let next = vec![
            &t._env,
            WaterfallTranche {
                priority: 2,
                tranche_bond_id: bond_ids[2],
                carbon_due: 25,
                biodiversity_due: 0,
            },
        ];
        let carried = t.client.settle_waterfall(&t.admin, &1, &next, &75, &0, &3);
        assert_eq!(carried.allocations.get(0).unwrap().priority, 1);
        assert_eq!(carried.allocations.get(0).unwrap().carbon_paid, 75);
        assert_eq!(carried.carry.get(0).unwrap().priority, 1);
    }

    #[test]
    fn test_waterfall_claimable_reads_issuer_snapshot() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let t = deploy(env, admin);
        let holder = Address::generate(&t._env);
        let bond_id =
            issue_and_subscribe(&t._env, &t, &create_project_id(&t._env, 9), &holder, 1_000);
        let other_holder = Address::generate(&t._env);
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
        issuer.subscribe(&other_holder, &bond_id, &9_000, &0);

        t.client.settle_waterfall(
            &t.admin,
            &bond_id,
            &vec![
                &t._env,
                WaterfallTranche {
                    priority: 0,
                    tranche_bond_id: bond_id,
                    carbon_due: 100,
                    biodiversity_due: 0,
                },
            ],
            &100,
            &0,
            &0,
        );
        assert_eq!(
            t.client.waterfall_claimable(&bond_id, &0, &holder).unwrap(),
            (10, 0)
        );
    }

    #[test]
    fn test_waterfall_claims_accrue_once_and_settle_through_existing_paths() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let t = deploy(env, admin);
        let holder = Address::generate(&t._env);
        let tranche_bond_id =
            issue_and_subscribe(&t._env, &t, &create_project_id(&t._env, 10), &holder, 1_000);
        let other_holder = Address::generate(&t._env);
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
        issuer.subscribe(&other_holder, &tranche_bond_id, &9_000, &0);
        let group_id = 99;
        let tranche = vec![
            &t._env,
            WaterfallTranche {
                priority: 0,
                tranche_bond_id,
                carbon_due: 100,
                biodiversity_due: 100,
            },
        ];

        t.client
            .settle_waterfall(&t.admin, &group_id, &tranche, &100, &100, &0);
        let transferee = Address::generate(&t._env);
        issuer.transfer(&holder, &transferee, &tranche_bond_id, &1_000, &1);
        assert_eq!(
            t.client.claim_waterfall(&holder, &group_id, &0, &0, &0),
            (10, 10)
        );
        assert_eq!(
            t.client.claim_waterfall(&transferee, &group_id, &0, &0, &0),
            (0, 0)
        );
        assert_eq!(t.client.accrued_credits(&group_id, &holder), 20);
        assert_eq!(
            t.client.try_claim_waterfall(&holder, &group_id, &0, &0, &1),
            Err(Ok(BondError::WaterfallAlreadyClaimed))
        );
        assert_eq!(t.client.claim_credits(&holder, &group_id, &1), 20);
        assert_eq!(t.client.accrued_credits(&group_id, &holder), 0);

        t.client
            .settle_waterfall(&t.admin, &group_id, &tranche, &100, &100, &1);
        assert_eq!(
            t.client.claim_waterfall(&holder, &group_id, &1, &0, &2),
            (10, 10)
        );
        t.client.consume_credits(&holder, &group_id, &10);
        assert_eq!(t.client.accrued_credits(&group_id, &holder), 10);
        assert_eq!(
            t.client
                .accrued_credits_by_type(&group_id, &holder, &CreditType::Carbon),
            0
        );
        assert_eq!(
            t.client
                .accrued_credits_by_type(&group_id, &holder, &CreditType::Biodiversity),
            10
        );
    }

    fn create_project_id(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[31] = value;
        BytesN::from_array(env, &arr)
    }

    fn make_ipfs_hash(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = value;
        BytesN::from_array(env, &arr)
    }

    fn make_bond_config(env: &Env, project_id: &BytesN<32>) -> nbbs_shared::BondConfig {
        nbbs_shared::BondConfig {
            project_id: project_id.clone(),
            face_value: 1000,
            coupon_schedule: vec![env, 1_000_000u64, 2_000_000u64],
            credit_type: nbbs_shared::CreditType::Carbon,
            maturity_date: 3_000_000,
            total_supply: 10_000,
            credit_vintage: 2024,
            serial_number_start: 1,
            serial_number_end: 10_000,
            
        }
    }

    fn make_bond_config_with_type(
        env: &Env,
        project_id: &BytesN<32>,
        credit_type: nbbs_shared::CreditType,
    ) -> nbbs_shared::BondConfig {
        nbbs_shared::BondConfig {
            credit_type,
            ..make_bond_config(env, project_id)
        }
    }

    struct TestEnv {
        _env: Env,
        admin: Address,
        issuer_id: Address,
        issuer_admin: Address,
        oracle_id: Address,
        client: CouponEngineClient<'static>,
    }

    fn deploy(env: Env, admin: Address) -> TestEnv {
        let issuer_admin = Address::generate(&env);
        let issuer_id = env.register(nbbs_bond_issuer::BondIssuer, (issuer_admin.clone(),));
        let oracle_id = env.register(nbbs_oracle_consumer::OracleConsumer, (admin.clone(),));
        let ce_id = env.register(
            CouponEngine,
            (admin.clone(), issuer_id.clone(), oracle_id.clone()),
        );
        let client = CouponEngineClient::new(&env, &ce_id);

        TestEnv {
            _env: env,
            admin,
            issuer_id,
            issuer_admin,
            oracle_id,
            client,
        }
    }

    fn issue_and_subscribe(
        env: &Env,
        t: &TestEnv,
        project_id: &BytesN<32>,
        holder: &Address,
        amount: i128,
    ) -> u64 {
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(env, &t.issuer_id);
        let config = make_bond_config(env, project_id);
        let bond_id = issuer.issue_bond(&t.issuer_admin, &config, &0);
        issuer.subscribe(holder, &bond_id, &amount, &0);
        bond_id
    }

    fn issue_and_subscribe_with_type(
        env: &Env,
        t: &TestEnv,
        project_id: &BytesN<32>,
        credit_type: nbbs_shared::CreditType,
        holder: &Address,
        amount: i128,
    ) -> u64 {
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(env, &t.issuer_id);
        let config = make_bond_config_with_type(env, project_id, credit_type);
        let bond_id = issuer.issue_bond(&t.issuer_admin, &config, &0);
        issuer.subscribe(holder, &bond_id, &amount, &0);
        bond_id
    }

    /// Consumes 3 of the admin's OracleConsumer nonces: registering the
    /// reporting provider (`admin_nonce`), the admin's own verification
    /// (`admin_nonce + 1`), and registering a second, independent verifier
    /// (`admin_nonce + 2`) to satisfy the default 2-verifier threshold. The
    /// admin's signature alone isn't sufficient (see "Multi-Source
    /// Verification Threshold" in docs/oracle-design.md).
    fn submit_verified_report(
        env: &Env,
        t: &TestEnv,
        project_id: &BytesN<32>,
        carbon: i128,
        biodiversity: BiodiversityMetrics,
        admin_nonce: u64,
    ) -> u64 {
        let oc = nbbs_oracle_consumer::OracleConsumerClient::new(env, &t.oracle_id);
        let provider = Address::generate(env);
        oc.register_provider(
            &t.admin,
            &provider,
            &Symbol::new(env, "verra_vcs"),
            &admin_nonce,
        );
        let report_id = oc.submit_report(
            &provider,
            project_id,
            &1000u64,
            &2000u64,
            &carbon,
            &biodiversity,
            &Symbol::new(env, "verra_vcs"),
            &make_ipfs_hash(env, 1),
            &0,
        );
        oc.verify_report(&t.admin, &report_id, &(admin_nonce + 1));
        report_id
    }

    fn submit_unverified_report(
        env: &Env,
        t: &TestEnv,
        project_id: &BytesN<32>,
        carbon: i128,
        biodiversity: BiodiversityMetrics,
        admin_nonce: u64,
    ) -> u64 {
        let oc = nbbs_oracle_consumer::OracleConsumerClient::new(env, &t.oracle_id);
        let provider = Address::generate(env);
        oc.register_provider(
            &t.admin,
            &provider,
            &Symbol::new(env, "verra_vcs"),
            &admin_nonce,
        );
        oc.submit_report(
            &provider,
            project_id,
            &1000u64,
            &2000u64,
            &carbon,
            &biodiversity,
            &Symbol::new(env, "verra_vcs"),
            &make_ipfs_hash(env, 1),
            &0,
        )
    }

    #[test]
    fn test_constructor_and_register_bond() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin.clone());

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 1000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let credit_type = t.client.get_bond_credit_type(&bond_id);
        assert_eq!(credit_type, nbbs_shared::CreditType::Carbon);

        let count = t.client.get_period_count(&bond_id);
        assert_eq!(count, 0);
    }

    #[test]
    fn test_register_bond_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let result = t.client.try_register_bond(&user, &1, &project_id, &0);
        assert_eq!(result, Err(Ok(BondError::Unauthorized)));
    }

    #[test]
    fn test_register_bond_invalid_nonce() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let result = t.client.try_register_bond(&t.admin, &1, &project_id, &1);
        assert_eq!(result, Err(Ok(BondError::InvalidNonce)));
    }

    #[test]
    fn test_distribute_to_single_holder() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder.clone()];

        let result = t
            .client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        assert_eq!(result.bond_id, bond_id);
        assert_eq!(result.period_index, 0);
        assert_eq!(result.total_credits, 100 * CREDIT_MINOR_UNITS);
        assert_eq!(result.holder_count, 1);
        assert_eq!(
            result.credits_per_token,
            100 * CREDIT_MINOR_UNITS * FIXED_POINT / 10000
        );

        let accrued = t.client.escrowed_credits(&bond_id, &holder);
        assert_eq!(accrued, 100 * CREDIT_MINOR_UNITS);

        let period_info = t.client.get_period_info(&bond_id, &0);
        assert!(period_info.distributed);
        assert_eq!(period_info.total_credits_earned, 100 * CREDIT_MINOR_UNITS);
        assert_eq!(period_info.report_id, report_id);
    }

    #[test]
    fn test_distribute_biodiversity_bond() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 2);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe_with_type(
            &t._env,
            &t,
            &project_id,
            nbbs_shared::CreditType::Biodiversity,
            &holder,
            10_000,
        );
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let credit_type = t.client.get_bond_credit_type(&bond_id);
        assert_eq!(credit_type, nbbs_shared::CreditType::Biodiversity);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            0,
            BiodiversityMetrics::Present((500, 125, 1_000)),
            0,
        );
        let holders = vec![&t._env, holder.clone()];

        let result = t
            .client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        let total =
            (500 * HABITAT_CREDIT_RATE + 125 * SPECIES_CREDIT_RATE + 1_000 * UNIT_CREDIT_RATE)
                * CREDIT_MINOR_UNITS
                / HABITAT_CREDIT_RATE;
        assert_eq!(result.total_credits, total);

        let accrued = t.client.escrowed_credits(&bond_id, &holder);
        assert_eq!(accrued, total);
        let by_type = t.client.escrowed_credits_by_type(
            &bond_id,
            &holder,
            &nbbs_shared::CreditType::Biodiversity,
        );
        assert_eq!(by_type, total);
    }

    #[test]
    fn test_distribute_basket_bond_splits_by_type() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 3);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe_with_type(
            &t._env,
            &t,
            &project_id,
            nbbs_shared::CreditType::Basket,
            &holder,
            10_000,
        );
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Present((500, 125, 1_000)),
            0,
        );
        let holders = vec![&t._env, holder.clone()];

        let result = t
            .client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        let bio_total =
            (500 * HABITAT_CREDIT_RATE + 125 * SPECIES_CREDIT_RATE + 1_000 * UNIT_CREDIT_RATE)
                * CREDIT_MINOR_UNITS
                / HABITAT_CREDIT_RATE;
        let carbon_total = 100 * CREDIT_MINOR_UNITS;
        assert_eq!(result.total_credits, carbon_total + bio_total);

        let carbon_accrued =
            t.client
                .escrowed_credits_by_type(&bond_id, &holder, &nbbs_shared::CreditType::Carbon);
        assert_eq!(carbon_accrued, carbon_total);
        let bio_accrued = t.client.escrowed_credits_by_type(
            &bond_id,
            &holder,
            &nbbs_shared::CreditType::Biodiversity,
        );
        assert_eq!(bio_accrued, bio_total);

        let combined = t.client.escrowed_credits(&bond_id, &holder);
        assert_eq!(combined, carbon_total + bio_total);
    }

    #[test]
    fn test_distribute_biodiversity_bond_requires_metrics() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 4);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe_with_type(
            &t._env,
            &t,
            &project_id,
            nbbs_shared::CreditType::Biodiversity,
            &holder,
            10_000,
        );
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id =
            submit_verified_report(&t._env, &t, &project_id, 0, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env, holder.clone()];

        let result = t
            .client
            .try_distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);
        assert_eq!(result, Err(Ok(BondError::InvalidReport)));
    }

    #[test]
    fn test_distribute_pro_rata_multiple_holders() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder1 = Address::generate(&t._env);
        let holder2 = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder1, 3_000);
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
        issuer.subscribe(&holder2, &bond_id, &7_000, &0);

        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder1.clone(), holder2.clone()];

        let result = t
            .client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        let total_credits = 100 * CREDIT_MINOR_UNITS;
        assert_eq!(result.total_credits, total_credits);
        assert_eq!(result.holder_count, 2);

        let total_sub = 10000i128;
        let expected_h1 = total_credits * 3000 / total_sub;
        let expected_h2 = total_credits * 7000 / total_sub;

        assert_eq!(t.client.escrowed_credits(&bond_id, &holder1), expected_h1);
        assert_eq!(t.client.escrowed_credits(&bond_id, &holder2), expected_h2);
        assert_eq!(expected_h1 + expected_h2, total_credits);
    }

    #[test]
    fn test_distribute_zero_sequestration() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id =
            submit_verified_report(&t._env, &t, &project_id, 0, BiodiversityMetrics::Absent, 0);
        let holders = vec![&t._env, holder.clone()];

        let result = t
            .client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        assert_eq!(result.total_credits, 0);
        assert_eq!(result.holder_count, 0);
        assert_eq!(result.credits_per_token, 0);

        let accrued = t.client.escrowed_credits(&bond_id, &holder);
        assert_eq!(accrued, 0);
    }

    #[test]
    fn test_distribute_rejects_unverified_report() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_unverified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder.clone()];

        let result = t
            .client
            .try_distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);
        assert_eq!(result, Err(Ok(BondError::ReportNotVerified)));

        let accrued = t.client.escrowed_credits(&bond_id, &holder);
        assert_eq!(accrued, 0);
    }

    #[test]
    fn test_distribute_rejects_report_for_other_project() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let other_project = create_project_id(&t._env, 2);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &other_project,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder.clone()];

        let result = t
            .client
            .try_distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);
        assert_eq!(result, Err(Ok(BondError::BondNotFound)));
    }

    #[test]
    fn test_prevent_double_distribute() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder.clone()];

        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        let result = t
            .client
            .try_distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &2);
        assert_eq!(result, Err(Ok(BondError::Overflow)));
    }

    #[test]
    fn test_distribute_unregistered_bond() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env];

        let result = t
            .client
            .try_distribute_coupon(&t.admin, &999, &0, &holders, &report_id, &0);
        assert_eq!(result, Err(Ok(BondError::BondNotFound)));
    }

    #[test]
    fn test_claim_credits() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder.clone()];
        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        let claimed = t.client.claim_credits(&holder, &bond_id, &0);
        assert_eq!(claimed, 100 * CREDIT_MINOR_UNITS);

        let accrued = t.client.escrowed_credits(&bond_id, &holder);
        assert_eq!(accrued, 0);
    }

    #[test]
    fn test_claimable_credit_details_round_trip() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder.clone()];
        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        assert_eq!(
            t.client.claimable_credits(&bond_id, &holder),
            100 * CREDIT_MINOR_UNITS
        );

        let details = t.client.claimable_credit_details(&bond_id, &holder);
        assert_eq!(details.len(), 1);
        assert_eq!(details.get(0).unwrap().period_index, 0);
        assert_eq!(details.get(0).unwrap().report_id, report_id);
        assert_eq!(
            details.get(0).unwrap().credit_type,
            nbbs_shared::CreditType::Carbon
        );
        assert_eq!(details.get(0).unwrap().amount, 100 * CREDIT_MINOR_UNITS);

        t.client.claim_credits(&holder, &bond_id, &0);
        assert_eq!(t.client.claimable_credits(&bond_id, &holder), 0);
        assert_eq!(
            t.client.claimable_credit_details(&bond_id, &holder).len(),
            0
        );
    }

    #[test]
    fn test_zero_holders_case() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env];

        let result = t
            .client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        assert_eq!(result.total_credits, 0);
        assert_eq!(result.holder_count, 0);
        assert!(result.credits_per_token >= 0);

        let period_info = t.client.get_period_info(&bond_id, &0);
        assert!(period_info.distributed);
    }

    #[test]
    fn test_period_count_increments() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        assert_eq!(t.client.get_period_count(&bond_id), 0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder.clone()];

        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);
        assert_eq!(t.client.get_period_count(&bond_id), 1);

        let report_id2 = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            200_000,
            BiodiversityMetrics::Absent,
            2,
        );
        t.client
            .distribute_coupon(&t.admin, &bond_id, &1, &holders, &report_id2, &2);
        assert_eq!(t.client.get_period_count(&bond_id), 2);
    }

    #[test]
    fn test_distribute_leaves_dust_and_sweep_recovers_it() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder_a = Address::generate(&t._env);
        let holder_b = Address::generate(&t._env);
        let holder_c = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder_a, 1);
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
        issuer.subscribe(&holder_b, &bond_id, &1, &0);
        issuer.subscribe(&holder_c, &bond_id, &1, &0);

        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![
            &t._env,
            holder_a.clone(),
            holder_b.clone(),
            holder_c.clone(),
        ];

        let result = t
            .client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        let total = 100 * CREDIT_MINOR_UNITS;
        let per_holder = total / 3; // each holder holds 1 of 3 tokens
        let distributed = per_holder * 3;
        assert_eq!(result.total_credits, distributed);

        let period_info = t.client.get_period_info(&bond_id, &0);
        assert_eq!(period_info.undistributed, total - distributed);

        assert_eq!(
            t.client.get_undistributed_total(&bond_id),
            total - distributed
        );

        let swept = t.client.sweep_undistributed(&t.admin, &bond_id, &2);
        assert_eq!(swept, total - distributed);

        assert_eq!(t.client.get_undistributed_total(&bond_id), 0);
    }

    #[test]
    fn test_distribute_rejects_duplicate_holders() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder.clone(), holder.clone()];

        let result = t
            .client
            .try_distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);
        assert_eq!(result, Err(Ok(BondError::Overflow)));
        assert_eq!(t.client.escrowed_credits(&bond_id, &holder), 0);
    }

    #[test]
    fn test_distribute_coupon_batch_pages_holders_sequentially() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder_a = Address::generate(&t._env);
        let holder_b = Address::generate(&t._env);

        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder_a, 5_000);
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
        issuer.subscribe(&holder_b, &bond_id, &5_000, &0);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder_a.clone(), holder_b.clone()];

        let first = t
            .client
            .distribute_coupon_batch(&t.admin, &bond_id, &0, &holders, &report_id, &0, &1, &1);
        assert_eq!(first.total_credits, 50 * CREDIT_MINOR_UNITS);
        assert!(!t.client.get_period_info(&bond_id, &0).distributed);
        assert_eq!(t.client.get_period_count(&bond_id), 0);

        let second = t
            .client
            .distribute_coupon_batch(&t.admin, &bond_id, &0, &holders, &report_id, &1, &1, &2);
        assert_eq!(second.total_credits, 100 * CREDIT_MINOR_UNITS);
        assert!(t.client.get_period_info(&bond_id, &0).distributed);
        assert_eq!(t.client.get_period_count(&bond_id), 1);
        assert_eq!(
            t.client.escrowed_credits(&bond_id, &holder_a),
            50 * CREDIT_MINOR_UNITS
        );
        assert_eq!(
            t.client.escrowed_credits(&bond_id, &holder_b),
            50 * CREDIT_MINOR_UNITS
        );
    }

    #[test]
    fn test_sweep_requires_admin() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 1);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder.clone()];
        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        let user = Address::generate(&t._env);
        let result = t.client.try_sweep_undistributed(&user, &bond_id, &0);
        assert_eq!(result, Err(Ok(BondError::Unauthorized)));
    }

    #[test]
    fn test_query_escrowed_credits_zero() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let oracle = Address::generate(&env);

        let contract_id = env.register(CouponEngine, (admin, issuer, oracle));
        let client = CouponEngineClient::new(&env, &contract_id);

        let holder = Address::generate(&env);
        let accrued = client.escrowed_credits(&1, &holder);
        assert_eq!(accrued, 0);
    }

    #[test]
    fn test_claim_credits_invalid_nonce() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let oracle = Address::generate(&env);

        let contract_id = env.register(CouponEngine, (admin, issuer, oracle));
        let client = CouponEngineClient::new(&env, &contract_id);

        let holder = Address::generate(&env);
        let result = client.try_claim_credits(&holder, &1, &1);
        assert_eq!(result, Err(Ok(BondError::InvalidNonce)));
    }

    #[test]
    fn test_consume_credits_debits_ledgers_oldest_first() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let t = deploy(env.clone(), admin);
        let project_id = create_project_id(&env, 1);
        let holder = Address::generate(&env);
        let bond_id = issue_and_subscribe(&env, &t, &project_id, &holder, 1_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);
        let holders = vec![&env, holder.clone()];

        // Two periods: 10 credits then 20 credits, all to one holder.
        let report_0 = submit_verified_report(
            &env,
            &t,
            &project_id,
            10_000,
            BiodiversityMetrics::Absent,
            0,
        );
        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_0, &1);
        let report_1 = submit_verified_report(
            &env,
            &t,
            &project_id,
            20_000,
            BiodiversityMetrics::Absent,
            3,
        );
        t.client
            .distribute_coupon(&t.admin, &bond_id, &1, &holders, &report_1, &2);
        let period_0 = 10 * CREDIT_MINOR_UNITS;
        let period_1 = 20 * CREDIT_MINOR_UNITS;
        assert_eq!(
            t.client.escrowed_credits(&bond_id, &holder),
            period_0 + period_1
        );

        // Consume more than period 0 holds: period 0 drains fully, period 1 partially.
        let amount = period_0 + 5 * CREDIT_MINOR_UNITS;
        t.client.consume_credits(&holder, &bond_id, &amount);
        assert_eq!(
            t.client.escrowed_credits(&bond_id, &holder),
            15 * CREDIT_MINOR_UNITS
        );
        assert_eq!(
            t.client
                .escrowed_credits_by_type(&bond_id, &holder, &CreditType::Carbon),
            15 * CREDIT_MINOR_UNITS
        );
        let details = t.client.claimable_credit_details(&bond_id, &holder);
        assert_eq!(details.len(), 1);
        assert_eq!(details.get(0).unwrap().period_index, 1);
        assert_eq!(details.get(0).unwrap().amount, 15 * CREDIT_MINOR_UNITS);

        // The rest can still be claimed, and only the rest.
        assert_eq!(
            t.client.claim_credits(&holder, &bond_id, &0),
            15 * CREDIT_MINOR_UNITS
        );
        assert_eq!(t.client.escrowed_credits(&bond_id, &holder), 0);
    }

    #[test]
    fn test_consume_credits_rejects_zero_and_overdraw() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let t = deploy(env.clone(), admin);
        let project_id = create_project_id(&env, 1);
        let holder = Address::generate(&env);
        let bond_id = issue_and_subscribe(&env, &t, &project_id, &holder, 1_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);
        let report = submit_verified_report(
            &env,
            &t,
            &project_id,
            10_000,
            BiodiversityMetrics::Absent,
            0,
        );
        t.client.distribute_coupon(
            &t.admin,
            &bond_id,
            &0,
            &vec![&env, holder.clone()],
            &report,
            &1,
        );
        let accrued = t.client.escrowed_credits(&bond_id, &holder);

        assert_eq!(
            t.client.try_consume_credits(&holder, &bond_id, &0),
            Err(Ok(BondError::ZeroAmount))
        );
        assert_eq!(
            t.client
                .try_consume_credits(&holder, &bond_id, &(accrued + 1)),
            Err(Ok(BondError::Overflow))
        );
        assert_eq!(t.client.escrowed_credits(&bond_id, &holder), accrued);
    }

    /// Same as `submit_verified_report` but with explicit reporting periods so
    /// multiple non-overlapping reports can be submitted for one project.
    fn submit_verified_report_with_period(
        env: &Env,
        t: &TestEnv,
        project_id: &BytesN<32>,
        carbon: i128,
        biodiversity: BiodiversityMetrics,
        admin_nonce: u64,
        period_start: u64,
        period_end: u64,
    ) -> u64 {
        let oc = nbbs_oracle_consumer::OracleConsumerClient::new(env, &t.oracle_id);
        let provider = Address::generate(env);
        oc.register_provider(
            &t.admin,
            &provider,
            &Symbol::new(env, "verra_vcs"),
            &admin_nonce,
        );
        let report_id = oc.submit_report(
            &provider,
            project_id,
            &period_start,
            &period_end,
            &carbon,
            &biodiversity,
            &Symbol::new(env, "verra_vcs"),
            &make_ipfs_hash(env, 1),
            &0,
        );
        oc.verify_report(&t.admin, &report_id, &(admin_nonce + 1));

        let second_verifier = Address::generate(env);
        oc.register_provider(
            &t.admin,
            &second_verifier,
            &Symbol::new(env, "satellite"),
            &(admin_nonce + 2),
        );
        oc.add_stake(
            &second_verifier,
            &nbbs_oracle_consumer::DEFAULT_MIN_VERIFIER_STAKE,
            &0,
        );
        oc.verify_report(&second_verifier, &report_id, &1);

        report_id
    }

    /// Issue #186: the first accepted observation is the baseline.
    #[test]
    fn test_first_performance_baseline_accepted() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report_with_period(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
            1_000,
            2_000,
        );
        let holders = vec![&t._env, holder.clone()];
        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        let history = t.client.get_performance_history(&bond_id);
        assert_eq!(history.len(), 1);
        assert_eq!(history.get(0).unwrap().carbon_sequestered, 100_000);
        assert!(!t.client.is_performance_flagged(&bond_id));
    }

    /// Issue #186: a manipulated spike (+200%) is flagged, pauses coupon
    /// distribution, and resumes only after an admin clears the flag.
    #[test]
    fn test_performance_spike_flags_and_pauses_coupons() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let baseline_report = submit_verified_report_with_period(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
            1_000,
            2_000,
        );
        let holders = vec![&t._env, holder.clone()];
        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &baseline_report, &1);

        // 100k → 300k is a +200% jump: outside the documented +100% bound.
        let spike_report = submit_verified_report_with_period(
            &t._env,
            &t,
            &project_id,
            300_000,
            BiodiversityMetrics::Absent,
            3,
            2_000,
            3_000,
        );
        let res = t
            .client
            .distribute_coupon(&t.admin, &bond_id, &1, &holders, &spike_report, &2);
        assert_eq!(res.total_credits, 0);

        // The flag pauses every subsequent distribution attempt.
        assert!(t.client.is_performance_flagged(&bond_id));
        let flag = t.client.get_performance_flag(&bond_id).unwrap();
        assert_eq!(flag.reason, PerformanceAnomaly::Spike);
        assert_eq!(flag.previous_value, 100_000);
        assert_eq!(flag.reported_value, 300_000);
        assert_eq!(
            t.client
                .try_distribute_coupon(&t.admin, &bond_id, &1, &holders, &spike_report, &3),
            Err(Ok(BondError::PerformanceFlagged))
        );

        // Nothing was silently clamped: no accruals for the flagged period.
        assert_eq!(t.client.get_period_count(&bond_id), 1);

        // After dispute resolution an admin clears the flag and a corrected
        // report (within bounds) distributes normally.
        t.client.clear_performance_flag(&t.admin, &bond_id, &3);
        assert!(!t.client.is_performance_flagged(&bond_id));

        let corrected_report = submit_verified_report_with_period(
            &t._env,
            &t,
            &project_id,
            120_000,
            BiodiversityMetrics::Absent,
            6,
            2_000,
            3_000,
        );
        t.client
            .distribute_coupon(&t.admin, &bond_id, &1, &holders, &corrected_report, &4);

        let history = t.client.get_performance_history(&bond_id);
        assert_eq!(history.len(), 2);
        assert_eq!(history.get(1).unwrap().carbon_sequestered, 120_000);
    }

    /// Issue #186: a genuine extreme event inside the bounds (-80%) is
    /// accepted rather than flagged.
    #[test]
    fn test_legitimate_extreme_drop_within_bounds() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let baseline_report = submit_verified_report_with_period(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
            1_000,
            2_000,
        );
        let holders = vec![&t._env, holder.clone()];
        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &baseline_report, &1);

        // -80% is within the -90% bound: a genuine collapse is accepted.
        let drop_report = submit_verified_report_with_period(
            &t._env,
            &t,
            &project_id,
            20_000,
            BiodiversityMetrics::Absent,
            3,
            2_000,
            3_000,
        );
        t.client
            .distribute_coupon(&t.admin, &bond_id, &1, &holders, &drop_report, &2);

        assert!(!t.client.is_performance_flagged(&bond_id));
        assert_eq!(t.client.get_performance_history(&bond_id).len(), 2);
    }

    /// Issue #186: a beyond-bound drop (consistent with a manipulated or
    /// erroneous feed) is flagged for review instead of being applied.
    #[test]
    fn test_erroneous_drop_flags_distribution() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let baseline_report = submit_verified_report_with_period(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
            1_000,
            2_000,
        );
        let holders = vec![&t._env, holder.clone()];
        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &baseline_report, &1);

        // -97% is outside the -90% bound.
        let drop_report = submit_verified_report_with_period(
            &t._env,
            &t,
            &project_id,
            3_000,
            BiodiversityMetrics::Absent,
            3,
            2_000,
            3_000,
        );
        let res = t
            .client
            .distribute_coupon(&t.admin, &bond_id, &1, &holders, &drop_report, &2);
        assert_eq!(res.total_credits, 0);

        let flag = t.client.get_performance_flag(&bond_id).unwrap();
        assert_eq!(flag.reason, PerformanceAnomaly::Drop);
        assert_eq!(flag.reported_value, 3_000);
    }

    /// Issue #186: fewer independent attestations than the coupon minimum
    /// blocks distribution even for a Verified report.
    #[test]
    fn test_insufficient_attestations_rejected() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        // Relax the verification threshold to 1 so a single-verifier report
        // reaches Verified while staying under the coupon minimum of 2.
        let oc = nbbs_oracle_consumer::OracleConsumerClient::new(&t._env, &t.oracle_id);
        oc.set_signature_threshold(&t.admin, &1, &0);

        let provider = Address::generate(&t._env);
        oc.register_provider(&t.admin, &provider, &Symbol::new(&t._env, "verra_vcs"), &1);
        let report_id = oc.submit_report(
            &provider,
            &project_id,
            &1_000u64,
            &2_000u64,
            &100_000i128,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&t._env, "verra_vcs"),
            &make_ipfs_hash(&t._env, 1),
            &0,
        );
        oc.verify_report(&t.admin, &report_id, &2);
        assert_eq!(oc.get_verification_count(&report_id), 1);

        let holders = vec![&t._env, holder.clone()];
        assert_eq!(
            t.client
                .try_distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1),
            Err(Ok(BondError::InsufficientAttestations))
        );

        // A second independent verifier restores eligibility.
        let second_verifier = Address::generate(&t._env);
        oc.register_provider(
            &t.admin,
            &second_verifier,
            &Symbol::new(&t._env, "satellite"),
            &3,
        );
        oc.add_stake(
            &second_verifier,
            &nbbs_oracle_consumer::DEFAULT_MIN_VERIFIER_STAKE,
            &0,
        );
        oc.verify_report(&second_verifier, &report_id, &1);

        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);
    }

    /// Issue #186: only the admin can clear a performance flag.
    #[test]
    fn test_clear_performance_flag_requires_admin() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let other = Address::generate(&t._env);
        assert_eq!(
            t.client.try_clear_performance_flag(&other, &bond_id, &0),
            Err(Ok(BondError::Unauthorized))
        );
    }

    /// Issue #188: an open migration window pauses distribution, claims and
    /// consumption so in-flight state cannot be mutated mid-cutover.
    #[test]
    fn test_migration_window_pauses_coupons_and_claims() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report_with_period(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
            1_000,
            2_000,
        );
        let holders = vec![&t._env, holder.clone()];
        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);
        assert!(t.client.escrowed_credits(&bond_id, &holder) > 0);

        t.client.begin_migration(&t.admin, &bond_id, &2);
        assert!(t.client.get_migration_window(&bond_id).is_some());

        assert_eq!(
            t.client
                .try_distribute_coupon(&t.admin, &bond_id, &1, &holders, &report_id, &3),
            Err(Ok(BondError::MigrationInProgress))
        );
        assert_eq!(
            t.client.try_claim_credits(&holder, &bond_id, &0),
            Err(Ok(BondError::MigrationInProgress))
        );
        assert_eq!(
            t.client.try_consume_credits(&holder, &bond_id, &1),
            Err(Ok(BondError::MigrationInProgress))
        );
    }

    /// Issue #188: rolling back a migration window proves the in-flight state
    /// (unclaimed coupons, undistributed total, period count) was preserved.
    #[test]
    fn test_rollback_preserves_in_flight_state() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_id = submit_verified_report_with_period(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
            1_000,
            2_000,
        );
        let holders = vec![&t._env, holder.clone()];
        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1);

        let undistributed_before = t.client.get_undistributed_total(&bond_id);
        let claimable_before = t.client.claimable_credits(&bond_id, &holder);
        assert!(claimable_before > 0);

        let window = t.client.begin_migration(&t.admin, &bond_id, &2);
        assert_eq!(window.snapshot_undistributed, undistributed_before);

        let restored = t.client.rollback_migration(&t.admin, &bond_id, &3);
        assert_eq!(restored.snapshot_undistributed, undistributed_before);
        assert!(t.client.get_migration_window(&bond_id).is_none());

        // In-flight state was not lost and is fully usable after rollback.
        assert_eq!(
            t.client.get_undistributed_total(&bond_id),
            undistributed_before
        );
        assert_eq!(
            t.client.claimable_credits(&bond_id, &holder),
            claimable_before
        );
        let claimed = t.client.claim_credits(&holder, &bond_id, &0);
        assert_eq!(claimed, claimable_before);
    }

    /// Issue #188: finalizing a migration window resumes the normal flow.
    #[test]
    fn test_finalize_migration_resumes_flow() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let report_0 = submit_verified_report_with_period(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
            1_000,
            2_000,
        );
        let holders = vec![&t._env, holder.clone()];
        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_0, &1);

        t.client.begin_migration(&t.admin, &bond_id, &2);
        t.client.finalize_migration(&t.admin, &bond_id, &3);
        assert!(t.client.get_migration_window(&bond_id).is_none());

        let report_1 = submit_verified_report_with_period(
            &t._env,
            &t,
            &project_id,
            110_000,
            BiodiversityMetrics::Absent,
            3,
            2_000,
            3_000,
        );
        t.client
            .distribute_coupon(&t.admin, &bond_id, &1, &holders, &report_1, &4);
        assert_eq!(t.client.get_period_count(&bond_id), 2);
    }

    /// Issue #188: a second begin while a window is open is rejected, and
    /// migration calls are admin-only.
    #[test]
    fn test_migration_window_admin_and_single_window() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let other = Address::generate(&t._env);
        assert_eq!(
            t.client.try_begin_migration(&other, &bond_id, &0),
            Err(Ok(BondError::Unauthorized))
        );

        // register_bond consumed the admin's coupon-engine nonce 0.
        t.client.begin_migration(&t.admin, &bond_id, &1);
        assert_eq!(
            t.client.try_begin_migration(&t.admin, &bond_id, &2),
            Err(Ok(BondError::Overflow))
        );
    }

    /// Issue #188: every contract exposes its interface/schema version.
    #[test]
    fn test_schema_version() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        assert_eq!(t.client.schema_version(), SCHEMA_VERSION);
    }

    mod property {
        extern crate std;

        use super::*;
        use proptest::prelude::*;

        fn expected_credits(total_credits: i128, total_subscribed: i128, balance: i128) -> i128 {
            if total_subscribed <= 0 || total_credits <= 0 {
                return 0;
            }
            total_credits * balance / total_subscribed
        }

        fn deploy_with_holders(
            env: Env,
            admin: Address,
            balances: &[i128],
        ) -> (TestEnv, std::vec::Vec<Address>, u64, i128) {
            let t = deploy(env, admin);
            let project_id = create_project_id(&t._env, 7);
            let total_subscribed: i128 = balances.iter().sum();

            let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
            let mut config = make_bond_config(&t._env, &project_id);
            config.total_supply = total_subscribed;
            let bond_id = issuer.issue_bond(&t.issuer_admin, &config, &0);

            let holders: std::vec::Vec<Address> = balances
                .iter()
                .map(|_| Address::generate(&t._env))
                .collect();
            for (holder, &amount) in holders.iter().zip(balances.iter()) {
                issuer.subscribe(holder, &bond_id, &amount, &0);
            }

            t.client.register_bond(&t.admin, &bond_id, &project_id, &0);
            (t, holders, bond_id, total_subscribed)
        }

        fn setup_with_balances(
            env: Env,
            admin: Address,
            balances: &[i128],
            carbon: i128,
        ) -> (TestEnv, std::vec::Vec<Address>, u64, i128, u64) {
            let (t, holders, bond_id, total_subscribed) = deploy_with_holders(env, admin, balances);
            let project_id = create_project_id(&t._env, 7);
            let report_id = submit_verified_report(
                &t._env,
                &t,
                &project_id,
                carbon,
                BiodiversityMetrics::Absent,
                0,
            );
            (t, holders, bond_id, total_subscribed, report_id)
        }

        fn expected_distributed(
            balances: &[i128],
            total_credits: i128,
            total_subscribed: i128,
        ) -> i128 {
            balances
                .iter()
                .map(|&balance| expected_credits(total_credits, total_subscribed, balance))
                .sum()
        }

        // ---- boundary-biased generators -----------------------------------
        //
        // Uniform ranges almost never land on the values where floor division
        // and unit conversion misbehave, so every strategy below mixes a set of
        // hand-picked edges with a uniform tail. Weights favour the edges.

        /// Sequestration amounts around the whole-credit boundary
        /// (`CREDIT_DIVISOR`), around zero, and a large realistic tail.
        fn carbon_strategy() -> impl Strategy<Value = i128> {
            prop_oneof![
                3 => proptest::sample::select(std::vec![
                    0,
                    1,
                    CREDIT_DIVISOR - 1,
                    CREDIT_DIVISOR,
                    CREDIT_DIVISOR + 1,
                    2 * CREDIT_DIVISOR - 1,
                    7 * CREDIT_DIVISOR + 999,
                    1_000_000_000,
                ]),
                1 => 0i128..100_000_000i128,
            ]
        }

        /// Holder balances biased toward 1, primes, and near-`FIXED_POINT`
        /// multiples that stress the two-stage floor in `checked_ratio`.
        fn balance_strategy() -> impl Strategy<Value = i128> {
            prop_oneof![
                3 => proptest::sample::select(std::vec![1, 2, 3, 7, 9, 11, 999, 1_000, 9_999]),
                1 => 1i128..10_000i128,
            ]
        }

        fn balances_strategy() -> impl Strategy<Value = std::vec::Vec<i128>> {
            proptest::collection::vec(balance_strategy(), 1..6)
        }

        /// Supply that is issued but never subscribed. Zero is the common case;
        /// the rest checks that unsubscribed tokens earn nothing and do not
        /// dilute subscribers.
        fn unsubscribed_strategy() -> impl Strategy<Value = i128> {
            proptest::sample::select(std::vec![0, 0, 0, 1, 9, 1_000])
        }

        fn credit_type_strategy() -> impl Strategy<Value = CreditType> {
            proptest::sample::select(std::vec![
                CreditType::Carbon,
                CreditType::BlueCarbon,
                CreditType::Biodiversity,
                CreditType::Basket,
            ])
        }

        /// Biodiversity metrics: absent, all-zero, single-unit, and mixed
        /// values, so both the "present but worthless" and the additive cases
        /// are exercised for every bond type.
        fn biodiversity_strategy() -> impl Strategy<Value = BiodiversityMetrics> {
            let component = proptest::sample::select(std::vec![0i128, 1, 9, 10, 999, 1_000]);
            prop_oneof![
                1 => Just(BiodiversityMetrics::Absent),
                1 => Just(BiodiversityMetrics::Present((0, 0, 0))),
                3 => (component.clone(), component.clone(), component)
                    .prop_map(BiodiversityMetrics::Present),
            ]
        }

        /// Mirrors `compute_biodiversity_credits` for in-range inputs.
        fn expected_biodiversity(metrics: BiodiversityMetrics) -> i128 {
            match metrics {
                BiodiversityMetrics::Absent => 0,
                BiodiversityMetrics::Present((habitat, species, units)) => {
                    habitat * HABITAT_CREDIT_RATE
                        + species * SPECIES_CREDIT_RATE
                        + units * UNIT_CREDIT_RATE
                }
            }
        }

        /// What `distribute_coupon` should mint for a report, per credit type,
        /// or `None` when it must reject the report as invalid for the type.
        fn expected_pool(
            credit_type: CreditType,
            carbon: i128,
            metrics: BiodiversityMetrics,
        ) -> Option<(i128, i128)> {
            let carbon_pool = carbon / CREDIT_DIVISOR * CREDIT_MINOR_UNITS;
            match (credit_type, metrics) {
                (CreditType::Carbon | CreditType::BlueCarbon, _) => Some((carbon_pool, 0)),
                (_, BiodiversityMetrics::Absent) => None,
                (CreditType::Biodiversity, m) => Some((0, expected_biodiversity(m))),
                (CreditType::Basket, m) => Some((carbon_pool, expected_biodiversity(m))),
            }
        }

        fn deploy_typed(
            env: Env,
            admin: Address,
            credit_type: CreditType,
            balances: &[i128],
            unsubscribed: i128,
        ) -> (TestEnv, std::vec::Vec<Address>, u64, i128) {
            let t = deploy(env, admin);
            let project_id = create_project_id(&t._env, 7);
            let total_subscribed: i128 = balances.iter().sum();

            let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
            let mut config = make_bond_config_with_type(&t._env, &project_id, credit_type);
            config.total_supply = total_subscribed + unsubscribed;
            let bond_id = issuer.issue_bond(&t.issuer_admin, &config, &0);

            let holders: std::vec::Vec<Address> = balances
                .iter()
                .map(|_| Address::generate(&t._env))
                .collect();
            for (holder, &amount) in holders.iter().zip(balances.iter()) {
                issuer.subscribe(holder, &bond_id, &amount, &0);
            }

            t.client.register_bond(&t.admin, &bond_id, &project_id, &0);
            (t, holders, bond_id, total_subscribed)
        }

        #[test]
        fn max_supply_and_coupon_pool_stay_within_documented_bound() {
            let env = Env::default();
            env.mock_all_auths();
            let admin = Address::generate(&env);
            let max_supply = nbbs_bond_issuer::MAX_SUPPLY;
            let first = max_supply / 3;
            let balances = [first, first, max_supply - first * 2];
            let (t, holders, bond_id, total_subscribed) =
                deploy_typed(env, admin, CreditType::Carbon, &balances, 0);
            assert_eq!(total_subscribed, max_supply);

            let report_id = submit_verified_report(
                &t._env,
                &t,
                &create_project_id(&t._env, 7),
                1_000_000_000_000_000,
                BiodiversityMetrics::Absent,
                0,
            );
            let mut holder_vec = Vec::new(&t._env);
            for holder in &holders {
                holder_vec.push_back(holder.clone());
            }
            let result =
                t.client
                    .distribute_coupon(&t.admin, &bond_id, &0, &holder_vec, &report_id, &1);

            let pool = MAX_COUPON_POOL;
            let mut distributed = 0i128;
            for holder in &holders {
                distributed += t.client.accrued_credits(&bond_id, holder);
            }
            let dust = t.client.get_undistributed_total(&bond_id);
            assert_eq!(distributed + dust, pool);
            assert_eq!(result.total_credits, distributed);
            assert!(pool.checked_mul(FIXED_POINT).is_some());
            let credits_per_token = pool.checked_mul(FIXED_POINT).unwrap() / max_supply;
            assert!(credits_per_token.checked_mul(max_supply).is_some());

            let mut reversed_holders = Vec::new(&t._env);
            let mut index = holders.len();
            while index > 0 {
                index -= 1;
                reversed_holders.push_back(holders.get(index).unwrap());
            }
            t.client
                .distribute_coupon(&t.admin, &bond_id, &1, &reversed_holders, &report_id, &2);
            for holder in &holders {
                let details = t.client.claimable_credit_details(&bond_id, holder);
                assert_eq!(
                    details.get(0).unwrap().amount,
                    details.get(1).unwrap().amount
                );
            }
        }

        #[test]
        fn full_supply_holder_receives_pool_without_double_rounding() {
            let env = Env::default();
            env.mock_all_auths();
            let admin = Address::generate(&env);
            let max_supply = nbbs_bond_issuer::MAX_SUPPLY;
            let (t, holders, bond_id, total_subscribed) =
                deploy_typed(env, admin, CreditType::Carbon, &[max_supply], 0);
            let carbon = 999_999_999_999_000i128;
            let report_id = submit_verified_report(
                &t._env,
                &t,
                &create_project_id(&t._env, 7),
                carbon,
                BiodiversityMetrics::Absent,
                0,
            );
            let holder_vec = Vec::from_array(&t._env, [holders[0].clone()]);
            let result =
                t.client
                    .distribute_coupon(&t.admin, &bond_id, &0, &holder_vec, &report_id, &1);

            let pool = carbon / CREDIT_DIVISOR * CREDIT_MINOR_UNITS;
            assert_eq!(pool, MAX_COUPON_POOL - CREDIT_MINOR_UNITS);
            assert_eq!(t.client.accrued_credits(&bond_id, &holders[0]), pool);
            assert_eq!(result.total_credits, pool);
            assert_eq!(t.client.get_undistributed_total(&bond_id), 0);
            let double_rounded = (pool * FIXED_POINT / total_subscribed) * max_supply / FIXED_POINT;
            assert!(double_rounded < pool);
        }

        proptest! {
            #![proptest_config(ProptestConfig {
                cases: 128,
                ..ProptestConfig::default()
            })]

            // Every credit type, every biodiversity shape, boundary-biased
            // amounts and balances, with and without unsubscribed supply. The
            // invariants below are the executable form of the coupon-math
            // guarantees in docs/coupon-math-invariants.md.
            #[test]
            fn typed_distribution_invariants(
                credit_type in credit_type_strategy(),
                carbon in carbon_strategy(),
                metrics in biodiversity_strategy(),
                balances in balances_strategy(),
                unsubscribed in unsubscribed_strategy(),
            ) {
                let env = Env::default();
                env.mock_all_auths();
                let admin = Address::generate(&env);
                let (t, holders, bond_id, total_subscribed) =
                    deploy_typed(env, admin, credit_type, &balances, unsubscribed);
                let report_id = submit_verified_report(
                    &t._env,
                    &t,
                    &create_project_id(&t._env, 7),
                    carbon,
                    metrics,
                    0,
                );

                let mut holders_vec: Vec<Address> = Vec::new(&t._env);
                for h in &holders {
                    holders_vec.push_back(h.clone());
                }

                let outcome = t.client.try_distribute_coupon(
                    &t.admin,
                    &bond_id,
                    &0,
                    &holders_vec,
                    &report_id,
                    &1,
                );

                // I0: a report without the metrics the bond pays on is rejected,
                // and rejection leaves no partial state behind.
                let Some((carbon_pool, bio_pool)) = expected_pool(credit_type, carbon, metrics) else {
                    prop_assert_eq!(outcome, Err(Ok(BondError::InvalidReport)));
                    prop_assert_eq!(t.client.get_period_count(&bond_id), 0);
                    prop_assert_eq!(t.client.get_undistributed_total(&bond_id), 0);
                    for h in &holders {
                        prop_assert_eq!(t.client.escrowed_credits(&bond_id, h), 0);
                    }
                    return Ok(());
                };
                let result = outcome.unwrap().unwrap();
                let pool = carbon_pool + bio_pool;

                // I1: conservation. Distributed plus dust equals the pool, and
                // the reported total is exactly the distributed subtotal.
                let mut distributed = 0i128;
                let mut credited = 0u32;
                for h in &holders {
                    let accrued = t.client.escrowed_credits(&bond_id, h);
                    prop_assert!(accrued >= 0);
                    distributed += accrued;
                    if accrued > 0 {
                        credited += 1;
                    }
                }
                let dust = t.client.get_undistributed_total(&bond_id);
                prop_assert_eq!(distributed + dust, pool);
                prop_assert_eq!(result.total_credits, distributed);
                prop_assert_eq!(result.holder_count, credited);

                // I2: dust is bounded by the number of floors taken: one per
                // holder for a single-type bond, two for a basket, plus one for
                // the credits-per-token floor.
                let floors = if credit_type == CreditType::Basket { 2 } else { 1 };
                prop_assert!(dust <= floors * (balances.len() as i128 + 1));

                // I3: no holder is paid more than their exact pro-rata share of
                // the pool over *subscribed* tokens, and unsubscribed supply
                // does not dilute anyone.
                for (h, &balance) in holders.iter().zip(balances.iter()) {
                    let accrued = t.client.escrowed_credits(&bond_id, h);
                    prop_assert!(accrued <= pool * balance / total_subscribed);
                    let by_type = t.client.escrowed_credits_by_type(&bond_id, h, &CreditType::Carbon)
                        + t.client.escrowed_credits_by_type(&bond_id, h, &CreditType::Biodiversity);
                    prop_assert_eq!(by_type, accrued);
                }

                // I4: monotone and fair. A larger balance never earns less, and
                // equal balances earn exactly the same.
                for (i, &bi) in balances.iter().enumerate() {
                    for (j, &bj) in balances.iter().enumerate() {
                        let ai = t.client.escrowed_credits(&bond_id, &holders[i]);
                        let aj = t.client.escrowed_credits(&bond_id, &holders[j]);
                        if bi > bj {
                            prop_assert!(ai >= aj);
                        } else if bi == bj {
                            prop_assert_eq!(ai, aj);
                        }
                    }
                }

                // I5: type routing. Carbon-only bonds never accrue biodiversity
                // credits, biodiversity-only bonds never accrue carbon, and a
                // basket splits the two pools independently.
                let mut carbon_seen = 0i128;
                let mut bio_seen = 0i128;
                for h in &holders {
                    carbon_seen += t.client.escrowed_credits_by_type(&bond_id, h, &CreditType::Carbon);
                    bio_seen += t.client.escrowed_credits_by_type(&bond_id, h, &CreditType::Biodiversity);
                }
                prop_assert!(carbon_seen <= carbon_pool);
                prop_assert!(bio_seen <= bio_pool);
                if carbon_pool == 0 {
                    prop_assert_eq!(carbon_seen, 0);
                }
                if bio_pool == 0 {
                    prop_assert_eq!(bio_seen, 0);
                }

                // I6: the period is closed exactly once and cannot be replayed.
                prop_assert_eq!(t.client.get_period_count(&bond_id), 1);
                prop_assert!(t
                    .client
                    .try_distribute_coupon(&t.admin, &bond_id, &0, &holders_vec, &report_id, &2)
                    .is_err());
            }

            // Sub-credit sequestration is truncated at the report level, before
            // scaling to minor units: a report below CREDIT_DIVISOR mints
            // nothing, and the remainder is never carried to the next period.
            #[test]
            fn whole_credit_truncation_is_per_report(
                remainder in 0i128..CREDIT_DIVISOR,
                whole in 0i128..1_000i128,
            ) {
                let carbon = whole * CREDIT_DIVISOR + remainder;
                let env = Env::default();
                env.mock_all_auths();
                let admin = Address::generate(&env);
                let (t, holders, bond_id, _) =
                    deploy_typed(env, admin, CreditType::Carbon, &[1], 0);
                let report_id = submit_verified_report(
                    &t._env,
                    &t,
                    &create_project_id(&t._env, 7),
                    carbon,
                    BiodiversityMetrics::Absent,
                    0,
                );
                let holders_vec = soroban_sdk::vec![&t._env, holders[0].clone()];
                let result = t.client.distribute_coupon(&t.admin, &bond_id, &0, &holders_vec, &report_id, &1);

                prop_assert_eq!(result.total_credits, whole * CREDIT_MINOR_UNITS);
                prop_assert_eq!(t.client.get_undistributed_total(&bond_id), 0);
            }

            // Pure helper property: within the range the oracle accepts and the
            // engine can pay out, biodiversity credits are exactly additive in
            // their three components. Larger inputs are rejected explicitly by
            // the checked helper.
            #[test]
            fn biodiversity_credits_are_additive(
                habitat in 0i128..1_000_000i128,
                species in 0i128..1_000_000i128,
                units in 0i128..1_000_000i128,
            ) {
                let metrics = BiodiversityMetrics::Present((habitat, species, units));
                prop_assert_eq!(
                    compute_biodiversity_credits(&metrics).unwrap(),
                    expected_biodiversity(metrics)
                );
                prop_assert_eq!(
                    compute_biodiversity_credits(&BiodiversityMetrics::Present((habitat, 0, 0))).unwrap()
                        + compute_biodiversity_credits(&BiodiversityMetrics::Present((0, species, 0))).unwrap()
                        + compute_biodiversity_credits(&BiodiversityMetrics::Present((0, 0, units))).unwrap(),
                    compute_biodiversity_credits(&metrics).unwrap()
                );
            }

            // Pure pro-rata math: floor-based distribution never allocates more
            // than the available credits and leaves a non-negative remainder that
            // reconciles exactly with the distributed amount.
            #[test]
            fn pro_rata_never_over_distributes(
                total_credits in 0i128..1_000_000i128,
                balances in proptest::collection::vec(1i128..100_000i128, 1..20),
            ) {
                let total_subscribed: i128 = balances.iter().sum();
                let mut distributed = 0i128;
                for &balance in &balances {
                    let credits = expected_credits(total_credits, total_subscribed, balance);
                    prop_assert!(credits >= 0);
                    prop_assert!(credits <= total_credits * balance / total_subscribed);
                    distributed += credits;
                }
                let undistributed = total_credits.saturating_sub(distributed);
                prop_assert!(undistributed >= 0);
                prop_assert!(distributed <= total_credits);
                prop_assert_eq!(distributed + undistributed, total_credits);
            }

            // On-chain invariant: sum of holder credits + undistributed == total
            // credits for an arbitrary holder distribution and sequestration amount.
            #[test]
            fn distribution_conserves_credits(
                carbon in 0i128..1_000_000_000i128,
                balances in proptest::collection::vec(1i128..10_000i128, 1..5),
            ) {
                let env = Env::default();
                env.mock_all_auths();

                let admin = Address::generate(&env);
                let (t, holders, bond_id, total_subscribed, report_id) =
                    setup_with_balances(env, admin.clone(), &balances, carbon);

                let mut holders_vec: Vec<Address> = Vec::new(&t._env);
                for h in &holders {
                    holders_vec.push_back(h.clone());
                }

                let total_credits = carbon / CREDIT_DIVISOR * CREDIT_MINOR_UNITS;
                let result = t.client.distribute_coupon(
                    &t.admin,
                    &bond_id,
                    &0,
                    &holders_vec,
                    &report_id,
                    &1,
                );

                let distributed =
                    expected_distributed(&balances, total_credits, total_subscribed);
                prop_assert_eq!(result.total_credits, distributed);

                let mut credited_holders = 0u32;
                for (holder, &balance) in holders.iter().zip(balances.iter()) {
                    let expected =
                        expected_credits(total_credits, total_subscribed, balance);
                    prop_assert_eq!(t.client.escrowed_credits(&bond_id, holder), expected);
                    if expected > 0 {
                        credited_holders += 1;
                    }
                }
                prop_assert_eq!(result.holder_count, credited_holders);

                let undistributed = total_credits.saturating_sub(distributed);
                prop_assert_eq!(t.client.get_undistributed_total(&bond_id), undistributed);
                prop_assert_eq!(distributed + undistributed, total_credits);

                let swept = t.client.sweep_undistributed(&t.admin, &bond_id, &2);
                prop_assert_eq!(swept, undistributed);
                prop_assert_eq!(t.client.get_undistributed_total(&bond_id), 0);
            }

            // Conservation across multiple periods: the running undistributed pool
            // is exactly the sum of each period's remainder, and the sum of all
            // accrued credits plus that pool equals the total credits issued.
            #[test]
            fn multi_period_conserves_credits(
                carbon_0 in 10_000i128..1_000_000i128,
                change_pct in 10i128..200i128, // -90% to +100% change
                balances in proptest::collection::vec(1i128..10_000i128, 1..4),
            ) {
                let carbon_1 = (carbon_0 * change_pct) / 100;
                let env = Env::default();
                env.mock_all_auths();

                let admin = Address::generate(&env);
                let (t, holders, bond_id, total_subscribed) =
                    deploy_with_holders(env, admin.clone(), &balances);

                let mut holders_vec: Vec<Address> = Vec::new(&t._env);
                for h in &holders {
                    holders_vec.push_back(h.clone());
                }

                let mut sum_undistributed = 0i128;
                for (period, &carbon) in [carbon_0, carbon_1].iter().enumerate() {
                    let report_id = submit_verified_report(
                        &t._env,
                        &t,
                        &create_project_id(&t._env, 7),
                        carbon,
                        BiodiversityMetrics::Absent,
                        (period as u64) * 2,
                    );
                    t.client.distribute_coupon(
                        &t.admin,
                        &bond_id,
                        &(period as u32),
                        &holders_vec,
                        &report_id,
                        &(1 + period as u64),
                    );
                    let total_credits = carbon / CREDIT_DIVISOR * CREDIT_MINOR_UNITS;
                    let distributed =
                        expected_distributed(&balances, total_credits, total_subscribed);
                    sum_undistributed += total_credits.saturating_sub(distributed);

                    let info = t.client.get_period_info(&bond_id, &(period as u32));
                    prop_assert_eq!(info.undistributed, total_credits.saturating_sub(distributed));
                }

                prop_assert_eq!(
                    t.client.get_undistributed_total(&bond_id),
                    sum_undistributed
                );

                let mut sum_accrued = 0i128;
                for (holder, &balance) in holders.iter().zip(balances.iter()) {
                    let mut holder_accrued = 0i128;
                    for &carbon in [carbon_0, carbon_1].iter() {
                        holder_accrued += expected_credits(
                            carbon / CREDIT_DIVISOR * CREDIT_MINOR_UNITS,
                            total_subscribed,
                            balance,
                        );
                    }
                    sum_accrued += holder_accrued;
                    prop_assert_eq!(t.client.escrowed_credits(&bond_id, holder), holder_accrued);
                }
                prop_assert_eq!(
                    sum_accrued + sum_undistributed,
                    (carbon_0 / CREDIT_DIVISOR * CREDIT_MINOR_UNITS)
                        + (carbon_1 / CREDIT_DIVISOR * CREDIT_MINOR_UNITS)
                );
            }

            // Audit-readiness (#214): randomized credit-type / tranche /
            // rounding fuzz. Enforces INV-1..INV-4 for every credit type:
            // distributed never exceeds the pool, no holder exceeds its
            // pro-rata cap, distributed + undistributed conserves the total,
            // and the per-type ledgers reconcile with the combined accrual.
            #[test]
            fn credit_type_never_over_distributes(
                credit_type_idx in 0u8..4u8,
                carbon in 0i128..1_000_000i128,
                habitat in 0i128..2_000i128,
                species in 0i128..2_000i128,
                units in 0i128..2_000i128,
                balances in proptest::collection::vec(1i128..10_000i128, 1..5),
            ) {
                use nbbs_shared::CreditType;
                let credit_type = match credit_type_idx {
                    0 => CreditType::Carbon,
                    1 => CreditType::BlueCarbon,
                    2 => CreditType::Biodiversity,
                    _ => CreditType::Basket,
                };
                let biodiversity = match credit_type {
                    CreditType::Carbon | CreditType::BlueCarbon => {
                        BiodiversityMetrics::Absent
                    }
                    CreditType::Biodiversity | CreditType::Basket => {
                        BiodiversityMetrics::Present((habitat, species, units))
                    }
                };

                let env = Env::default();
                env.mock_all_auths();
                let admin = Address::generate(&env);
                let t = deploy(env, admin);
                let project_id = create_project_id(&t._env, 9);
                let total_subscribed: i128 = balances.iter().sum();

                let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
                let mut config = make_bond_config_with_type(&t._env, &project_id, credit_type);
                config.total_supply = total_subscribed;
                let bond_id = issuer.issue_bond(&t.issuer_admin, &config, &0);
                let holders: std::vec::Vec<Address> = balances
                    .iter()
                    .map(|_| Address::generate(&t._env))
                    .collect();
                for (holder, &amount) in holders.iter().zip(balances.iter()) {
                    issuer.subscribe(holder, &bond_id, &amount, &0);
                }
                t.client.register_bond(&t.admin, &bond_id, &project_id, &0);
                let report_id = submit_verified_report(
                    &t._env,
                    &t,
                    &project_id,
                    carbon,
                    biodiversity,
                    0,
                );

                let mut holders_vec: Vec<Address> = Vec::new(&t._env);
                for h in &holders {
                    holders_vec.push_back(h.clone());
                }
                let result = t.client.distribute_coupon(
                    &t.admin,
                    &bond_id,
                    &0,
                    &holders_vec,
                    &report_id,
                    &1,
                );

                // Recompute the expected pool with the contract's own
                // conversion so the test tracks the audited formula exactly.
                let carbon_total = carbon / CREDIT_DIVISOR * CREDIT_MINOR_UNITS;
                let bio_total =
                    (habitat * HABITAT_CREDIT_RATE + species * SPECIES_CREDIT_RATE + units * UNIT_CREDIT_RATE)
                        * CREDIT_MINOR_UNITS
                        / HABITAT_CREDIT_RATE;
                let total_credits = match credit_type {
                    CreditType::Carbon | CreditType::BlueCarbon => carbon_total,
                    CreditType::Biodiversity => bio_total,
                    CreditType::Basket => carbon_total + bio_total,
                };

                // INV-1: never distribute more than the pool.
                prop_assert!(result.total_credits <= total_credits);
                // INV-3: conservation against the on-chain remainder.
                let info = t.client.get_period_info(&bond_id, &0);
                prop_assert_eq!(result.total_credits + info.undistributed, total_credits);
                prop_assert_eq!(
                    t.client.get_undistributed_total(&bond_id),
                    info.undistributed
                );

                // INV-2 + INV-4: per-holder cap and type-ledger consistency.
                let mut sum_accrued = 0i128;
                for (holder, &balance) in holders.iter().zip(balances.iter()) {
                    let accrued = t.client.escrowed_credits(&bond_id, holder);
                    let carbon_leg =
                        t.client.escrowed_credits_by_type(&bond_id, holder, &CreditType::Carbon);
                    let bio_leg = t.client.escrowed_credits_by_type(
                        &bond_id,
                        holder,
                        &CreditType::Biodiversity,
                    );
                    prop_assert_eq!(accrued, carbon_leg + bio_leg);
                    // Upper bound of the floor-rounded pro-rata share.
                    let cap = if total_subscribed > 0 {
                        total_credits.saturating_mul(balance) / total_subscribed
                    } else {
                        0
                    };
                    prop_assert!(accrued <= cap);
                    prop_assert!(accrued >= 0);
                    match credit_type {
                        CreditType::Carbon | CreditType::BlueCarbon => {
                            prop_assert_eq!(bio_leg, 0)
                        }
                        CreditType::Biodiversity => prop_assert_eq!(carbon_leg, 0),
                        CreditType::Basket => {}
                    }
                    sum_accrued += accrued;
                }
                prop_assert_eq!(sum_accrued, result.total_credits);
            }
        }
    }

    #[test]
    fn test_submit_true_up_adjustment_and_forward_application() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        // Submit true-up adjustment forward
        t.client.submit_true_up_adjustment(
            &t.admin,
            &bond_id,
            &0,
            &50_000_000i128,
            &Symbol::new(&t._env, "audit_reconciliation"),
            &make_ipfs_hash(&t._env, 1),
            &1,
        );

        let adjustments = t.client.get_true_up_adjustments(&bond_id);
        assert_eq!(adjustments.len(), 1);
        let adj = adjustments.get(0).unwrap();
        assert_eq!(adj.adjustment_amount, 50_000_000i128);
        assert!(!adj.applied);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            0,
        );
        let holders = vec![&t._env, holder.clone()];
        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &2);

        let adjustments_after = t.client.get_true_up_adjustments(&bond_id);
        assert!(adjustments_after.get(0).unwrap().applied);
    }

    #[test]
    fn test_coupon_distribution_dispute_frozen() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let oc = nbbs_oracle_consumer::OracleConsumerClient::new(&t._env, &t.oracle_id);
        oc.set_minimum_dispute_bond(&t.admin, &1_000, &0);
        let provider = Address::generate(&t._env);
        let challenger = Address::generate(&t._env);
        oc.register_provider(&t.admin, &provider, &Symbol::new(&t._env, "verra_vcs"), &1);
        oc.register_provider(&t.admin, &challenger, &Symbol::new(&t._env, "disputer"), &2);

        let report_id = oc.submit_report(
            &provider,
            &project_id,
            &1000,
            &2000,
            &100_000,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&t._env, "verra_vcs"),
            &make_ipfs_hash(&t._env, 1),
            &0,
        );
        oc.set_signature_threshold(&t.admin, &1, &3);
        oc.verify_report(&t.admin, &report_id, &4);

        oc.add_stake(&challenger, &2_000, &0);
        oc.challenge_report(&challenger, &report_id, &make_ipfs_hash(&t._env, 2), &1);

        let holders = vec![&t._env, holder.clone()];
        assert_eq!(
            t.client
                .try_distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1),
            Err(Ok(BondError::ProjectDisputedAndFrozen))
        );
    }

    #[test]
    fn test_coupon_distribution_oracle_staleness_tiered() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let t = deploy(env, admin);

        let project_id = create_project_id(&t._env, 42);
        let holder = Address::generate(&t._env);
        let bond_id = issue_and_subscribe(&t._env, &t, &project_id, &holder, 10_000);
        t.client.register_bond(&t.admin, &bond_id, &project_id, &0);

        let oc = nbbs_oracle_consumer::OracleConsumerClient::new(&t._env, &t.oracle_id);
        oc.set_project_staleness_config(&t.admin, &project_id, &100, &500, &1000, &0);

        let report_id = submit_verified_report(
            &t._env,
            &t,
            &project_id,
            100_000,
            BiodiversityMetrics::Absent,
            1,
        );
        let holders = vec![&t._env, holder.clone()];

        // Advance ledger timestamp beyond threshold2 (500s) relative to report verification timestamp
        t._env.ledger().set_timestamp(1_000);

        assert_eq!(
            t.client
                .try_distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1),
            Err(Ok(BondError::OracleStaleManualInterventionRequired))
        );
    }
}
