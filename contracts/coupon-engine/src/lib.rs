#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]
use nbbs_shared::Report;
use nbbs_shared::{BiodiversityMetrics, BondError, CreditType, ReportStatus};
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
    AccruedCredits(u64, Address),
    AccruedCreditsByType(u64, Address, CreditType),
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
        if env.storage().instance().has(&DataKey::PerformanceFlag(bond_id)) {
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
        validate_performance_update(
            &env,
            bond_id,
            report_id,
            period_index,
            report.carbon_sequestered,
        )?;

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
        let (carbon_total, biodiversity_total) = match credit_type {
            CreditType::Carbon | CreditType::BlueCarbon => (carbon_total, 0),
            CreditType::Biodiversity => match report.biodiversity {
                BiodiversityMetrics::Absent => return Err(BondError::InvalidReport),
                ref metrics => (0, compute_biodiversity_credits(metrics)),
            },
            CreditType::Basket => match report.biodiversity {
                BiodiversityMetrics::Absent => return Err(BondError::InvalidReport),
                ref metrics => (carbon_total, compute_biodiversity_credits(metrics)),
            },
        };
        let total_credits = carbon_total
            .checked_add(biodiversity_total)
            .ok_or(BondError::Overflow)?;

        let total_subscribed: i128 = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "total_subscribed"),
            vec![&env, bond_id.into_val(&env)],
        );

        let mut total_holder_credits: i128 = 0;
        let mut holder_count: u32 = 0;

        let credits_per_token = if total_subscribed > 0 && total_credits > 0 {
            checked_ratio(total_credits, FIXED_POINT, total_subscribed)?
        } else {
            0
        };
        let carbon_per_token = if total_subscribed > 0 && carbon_total > 0 {
            checked_ratio(carbon_total, FIXED_POINT, total_subscribed)?
        } else {
            0
        };
        let biodiversity_per_token = if total_subscribed > 0 && biodiversity_total > 0 {
            checked_ratio(biodiversity_total, FIXED_POINT, total_subscribed)?
        } else {
            0
        };

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
                            checked_ratio(credits_per_token, balance, FIXED_POINT)?;
                        if holder_credits > 0 {
                            total_holder_credits = total_holder_credits
                                .checked_add(holder_credits)
                                .ok_or(BondError::Overflow)?;
                            accrue_credits(
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
                            checked_ratio(credits_per_token, balance, FIXED_POINT)?;
                        if holder_credits > 0 {
                            total_holder_credits = total_holder_credits
                                .checked_add(holder_credits)
                                .ok_or(BondError::Overflow)?;
                            accrue_credits(
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
                        let carbon_holder = checked_ratio(carbon_per_token, balance, FIXED_POINT)?;
                        let biodiversity_holder =
                            checked_ratio(biodiversity_per_token, balance, FIXED_POINT)?;
                        let holder_credits = carbon_holder
                            .checked_add(biodiversity_holder)
                            .ok_or(BondError::Overflow)?;
                        if holder_credits > 0 {
                            total_holder_credits = total_holder_credits
                                .checked_add(holder_credits)
                                .ok_or(BondError::Overflow)?;
                            if carbon_holder > 0 {
                                accrue_credits(
                                    &env,
                                    bond_id,
                                    period_index,
                                    holder.clone(),
                                    CreditType::Carbon,
                                    carbon_holder,
                                )?;
                            }
                            if biodiversity_holder > 0 {
                                accrue_credits(
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

    pub fn accrued_credits(env: Env, bond_id: u64, holder: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::AccruedCredits(bond_id, holder))
            .unwrap_or(0)
    }

    pub fn accrued_credits_by_type(
        env: Env,
        bond_id: u64,
        holder: Address,
        credit_type: CreditType,
    ) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::AccruedCreditsByType(bond_id, holder, credit_type))
            .unwrap_or(0)
    }

    /// Total claimable coupons for a holder on a bond, in minor units (#156).
    pub fn claimable_credits(env: Env, bond_id: u64, holder: Address) -> i128 {
        Self::accrued_credits(env, bond_id, holder)
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

        let key = DataKey::AccruedCredits(bond_id, caller.clone());
        let accrued: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &0i128);

        if accrued > 0 {
            let credit_type = env
                .storage()
                .instance()
                .get(&DataKey::BondCreditType(bond_id));
            match credit_type {
                Some(CreditType::Carbon) | Some(CreditType::BlueCarbon) => {
                    clear_accrued(&env, bond_id, &caller, CreditType::Carbon);
                }
                Some(CreditType::Biodiversity) => {
                    clear_accrued(&env, bond_id, &caller, CreditType::Biodiversity);
                }
                Some(CreditType::Basket) => {
                    clear_accrued(&env, bond_id, &caller, CreditType::Carbon);
                    clear_accrued(&env, bond_id, &caller, CreditType::Biodiversity);
                }
                None => {}
            }

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

        let key = DataKey::AccruedCredits(bond_id, holder.clone());
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
                    DataKey::AccruedCreditsByType(bond_id, holder.clone(), credit_type);
                let by_type: i128 = env.storage().persistent().get(&by_type_key).unwrap_or(0);
                env.storage().persistent().set(
                    &by_type_key,
                    &by_type.checked_sub(take).ok_or(BondError::Overflow)?,
                );
                left -= take;
            }
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
        env.storage().instance().has(&DataKey::PerformanceFlag(bond_id))
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

        if !env.storage().instance().has(&DataKey::PerformanceFlag(bond_id)) {
            return Err(BondError::BondNotFound);
        }

        env.storage()
            .instance()
            .remove(&DataKey::PerformanceFlag(bond_id));
        env.events().publish(
            (Symbol::new(&env, "performance_unflagged"),),
            (bond_id,),
        );

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
        env.events().publish(
            (Symbol::new(&env, "migration_started"),),
            (bond_id,),
        );

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
        env.events().publish(
            (Symbol::new(&env, "migration_finalized"),),
            (bond_id,),
        );

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
        env.events().publish(
            (Symbol::new(&env, "migration_rolled_back"),),
            (bond_id,),
        );

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

fn compute_biodiversity_credits(metrics: &BiodiversityMetrics) -> i128 {
    let (habitat, species, units) = match metrics {
        BiodiversityMetrics::Absent => return 0,
        BiodiversityMetrics::Present(v) => *v,
    };
    habitat
        .saturating_mul(HABITAT_CREDIT_RATE)
        .saturating_add(species.saturating_mul(SPECIES_CREDIT_RATE))
        .saturating_add(units.saturating_mul(UNIT_CREDIT_RATE))
        .saturating_mul(CREDIT_MINOR_UNITS)
        .saturating_div(HABITAT_CREDIT_RATE)
}

fn accrue_credits(
    env: &Env,
    bond_id: u64,
    period_index: u32,
    holder: Address,
    credit_type: CreditType,
    amount: i128,
) -> Result<(), BondError> {
    let by_type_key = DataKey::AccruedCreditsByType(bond_id, holder.clone(), credit_type);
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

    let combined_key = DataKey::AccruedCredits(bond_id, holder);
    let combined: i128 = env.storage().persistent().get(&combined_key).unwrap_or(0);
    env.storage().persistent().set(
        &combined_key,
        &combined.checked_add(amount).ok_or(BondError::Overflow)?,
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
    let key = DataKey::AccruedCreditsByType(bond_id, holder.clone(), credit_type);
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

/// Issue #188: coupon writes for a bond with an open migration window are
/// paused so in-flight state cannot be mutated mid-cutover.
fn require_no_migration_window(env: &Env, bond_id: u64) -> Result<(), BondError> {
    if env.storage().instance().has(&DataKey::MigrationWindow(bond_id)) {
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
    period_index: u32,
    carbon_sequestered: i128,
) -> Result<(), BondError> {
    let history: Vec<PerformanceRecord> = env
        .storage()
        .instance()
        .get(&DataKey::PerformanceHistory(bond_id))
        .unwrap_or(vec![env]);
    let previous = match history.len() {
        0 => return Ok(()), // no history yet: this observation is the baseline
        len => history.get(len - 1).ok_or(BondError::Overflow)?,
    };

    if previous.carbon_sequestered <= 0 {
        // A non-positive baseline cannot bound a ratio; accept the update.
        return Ok(());
    }

    let reason = if carbon_sequestered > previous.carbon_sequestered {
        let delta = carbon_sequestered - previous.carbon_sequestered;
        let increase_bps = delta
            .checked_mul(10_000)
            .ok_or(BondError::Overflow)?
            .checked_div(previous.carbon_sequestered)
            .ok_or(BondError::Overflow)?;
        if increase_bps <= MAX_PERFORMANCE_INCREASE_BPS {
            return Ok(());
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
            return Ok(());
        }
        PerformanceAnomaly::Drop
    } else {
        return Ok(());
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
        (Symbol::new(&env, "performance_flagged"),),
        (bond_id, report_id),
    );

    Err(BondError::PerformanceFlagged)
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
    use soroban_sdk::{testutils::Address as _, vec, BytesN, Env, Symbol};

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

        let accrued = t.client.accrued_credits(&bond_id, &holder);
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

        let accrued = t.client.accrued_credits(&bond_id, &holder);
        assert_eq!(accrued, total);
        let by_type = t.client.accrued_credits_by_type(
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
                .accrued_credits_by_type(&bond_id, &holder, &nbbs_shared::CreditType::Carbon);
        assert_eq!(carbon_accrued, carbon_total);
        let bio_accrued = t.client.accrued_credits_by_type(
            &bond_id,
            &holder,
            &nbbs_shared::CreditType::Biodiversity,
        );
        assert_eq!(bio_accrued, bio_total);

        let combined = t.client.accrued_credits(&bond_id, &holder);
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
        let credits_per_token = total_credits * FIXED_POINT / total_sub;
        let expected_h1 = credits_per_token * 3000 / FIXED_POINT;
        let expected_h2 = credits_per_token * 7000 / FIXED_POINT;

        assert_eq!(t.client.accrued_credits(&bond_id, &holder1), expected_h1);
        assert_eq!(t.client.accrued_credits(&bond_id, &holder2), expected_h2);
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

        let accrued = t.client.accrued_credits(&bond_id, &holder);
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

        let accrued = t.client.accrued_credits(&bond_id, &holder);
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

        let accrued = t.client.accrued_credits(&bond_id, &holder);
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
            3,
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
        let credits_per_token = total * FIXED_POINT / 3;
        let per_holder = credits_per_token / FIXED_POINT; // each holder holds 1 token
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
        assert_eq!(t.client.accrued_credits(&bond_id, &holder), 0);
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
            t.client.accrued_credits(&bond_id, &holder_a),
            50 * CREDIT_MINOR_UNITS
        );
        assert_eq!(
            t.client.accrued_credits(&bond_id, &holder_b),
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
    fn test_query_accrued_credits_zero() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let issuer = Address::generate(&env);
        let oracle = Address::generate(&env);

        let contract_id = env.register(CouponEngine, (admin, issuer, oracle));
        let client = CouponEngineClient::new(&env, &contract_id);

        let holder = Address::generate(&env);
        let accrued = client.accrued_credits(&1, &holder);
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
            t.client.accrued_credits(&bond_id, &holder),
            period_0 + period_1
        );

        // Consume more than period 0 holds: period 0 drains fully, period 1 partially.
        let amount = period_0 + 5 * CREDIT_MINOR_UNITS;
        t.client.consume_credits(&holder, &bond_id, &amount);
        assert_eq!(
            t.client.accrued_credits(&bond_id, &holder),
            15 * CREDIT_MINOR_UNITS
        );
        assert_eq!(
            t.client
                .accrued_credits_by_type(&bond_id, &holder, &CreditType::Carbon),
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
        assert_eq!(t.client.accrued_credits(&bond_id, &holder), 0);
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
        let accrued = t.client.accrued_credits(&bond_id, &holder);

        assert_eq!(
            t.client.try_consume_credits(&holder, &bond_id, &0),
            Err(Ok(BondError::ZeroAmount))
        );
        assert_eq!(
            t.client
                .try_consume_credits(&holder, &bond_id, &(accrued + 1)),
            Err(Ok(BondError::Overflow))
        );
        assert_eq!(t.client.accrued_credits(&bond_id, &holder), accrued);
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
        assert_eq!(
            t.client
                .try_distribute_coupon(&t.admin, &bond_id, &1, &holders, &spike_report, &2),
            Err(Ok(BondError::PerformanceFlagged))
        );

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
        t.client.clear_performance_flag(&t.admin, &bond_id, &4);
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
            .distribute_coupon(&t.admin, &bond_id, &1, &holders, &corrected_report, &5);

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
        assert_eq!(
            t.client
                .try_distribute_coupon(&t.admin, &bond_id, &1, &holders, &drop_report, &2),
            Err(Ok(BondError::PerformanceFlagged))
        );

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
        assert_eq!(
            oc.get_verification_count(&report_id),
            1
        );

        let holders = vec![&t._env, holder.clone()];
        assert_eq!(
            t.client
                .try_distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &1),
            Err(Ok(BondError::InsufficientAttestations))
        );

        // A second independent verifier restores eligibility.
        let second_verifier = Address::generate(&t._env);
        oc.register_provider(&t.admin, &second_verifier, &Symbol::new(&t._env, "satellite"), &3);
        oc.add_stake(
            &second_verifier,
            &nbbs_oracle_consumer::DEFAULT_MIN_VERIFIER_STAKE,
            &0,
        );
        oc.verify_report(&second_verifier, &report_id, &1);

        t.client
            .distribute_coupon(&t.admin, &bond_id, &0, &holders, &report_id, &2);
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
        assert!(t.client.accrued_credits(&bond_id, &holder) > 0);

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
        assert_eq!(t.client.get_undistributed_total(&bond_id), undistributed_before);
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
            let credits_per_token = total_credits * FIXED_POINT / total_subscribed;
            credits_per_token * balance / FIXED_POINT
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
                        prop_assert_eq!(t.client.accrued_credits(&bond_id, h), 0);
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
                    let accrued = t.client.accrued_credits(&bond_id, h);
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
                    let accrued = t.client.accrued_credits(&bond_id, h);
                    prop_assert!(accrued <= pool * balance / total_subscribed);
                    let by_type = t.client.accrued_credits_by_type(&bond_id, h, &CreditType::Carbon)
                        + t.client.accrued_credits_by_type(&bond_id, h, &CreditType::Biodiversity);
                    prop_assert_eq!(by_type, accrued);
                }

                // I4: monotone and fair. A larger balance never earns less, and
                // equal balances earn exactly the same.
                for (i, &bi) in balances.iter().enumerate() {
                    for (j, &bj) in balances.iter().enumerate() {
                        let ai = t.client.accrued_credits(&bond_id, &holders[i]);
                        let aj = t.client.accrued_credits(&bond_id, &holders[j]);
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
                    carbon_seen += t.client.accrued_credits_by_type(&bond_id, h, &CreditType::Carbon);
                    bio_seen += t.client.accrued_credits_by_type(&bond_id, h, &CreditType::Biodiversity);
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
            // their three components. Larger inputs saturate inside the helper
            // but are always rejected downstream by checked_ratio (Overflow).
            #[test]
            fn biodiversity_credits_are_additive(
                habitat in 0i128..1_000_000i128,
                species in 0i128..1_000_000i128,
                units in 0i128..1_000_000i128,
            ) {
                let metrics = BiodiversityMetrics::Present((habitat, species, units));
                prop_assert_eq!(
                    compute_biodiversity_credits(&metrics),
                    expected_biodiversity(metrics)
                );
                prop_assert_eq!(
                    compute_biodiversity_credits(&BiodiversityMetrics::Present((habitat, 0, 0)))
                        + compute_biodiversity_credits(&BiodiversityMetrics::Present((0, species, 0)))
                        + compute_biodiversity_credits(&BiodiversityMetrics::Present((0, 0, units))),
                    compute_biodiversity_credits(&metrics)
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
                    prop_assert_eq!(t.client.accrued_credits(&bond_id, holder), expected);
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
                carbon_0 in 0i128..1_000_000i128,
                carbon_1 in 0i128..1_000_000i128,
                balances in proptest::collection::vec(1i128..10_000i128, 1..4),
            ) {
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
                        (period as u64) * 3,
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
                    prop_assert_eq!(t.client.accrued_credits(&bond_id, holder), holder_accrued);
                }
                prop_assert_eq!(
                    sum_accrued + sum_undistributed,
                    (carbon_0 / CREDIT_DIVISOR * CREDIT_MINOR_UNITS)
                        + (carbon_1 / CREDIT_DIVISOR * CREDIT_MINOR_UNITS)
                );
            }
        }
    }
}
