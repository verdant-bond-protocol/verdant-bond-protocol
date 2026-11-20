use super::*;

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct CovenantConfig {
    /// Verified oracle carbon quantity in the report's native units.
    pub min_performance: i128,
    /// Minimum funded principal in the issuer's on-chain redemption pool.
    pub min_redemption_funding: i128,
    pub breach_cycles: u32,
    pub recovery_cycles: u32,
    /// Coupon multiplier while stepped down, in [0, 10000).
    pub stepped_coupon_bps: u32,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct CovenantState {
    pub stepped_down: bool,
    pub consecutive_breaches: u32,
    pub consecutive_clean: u32,
    pub last_period_end: u64,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct CovenantCycle {
    pub report_id: u64,
    pub performance: i128,
    pub redemption_funding: i128,
    pub breached: bool,
    pub state: CovenantState,
    pub coupon_bps: u32,
    pub carbon_pool: i128,
    pub biodiversity_pool: i128,
}

#[derive(Clone)]
#[contracttype]
// Contracttype serializes the variant name, not the enum name. Prefixes keep
// these storage keys distinct from the engine's existing DataKey variants.
#[allow(clippy::enum_variant_names)]
enum CovenantKey {
    TrancheCovenant(u64),
    TrancheCovenantState(u64),
    TrancheCovenantCycle(u64, u32),
    TrancheCovenantLiveCycle(u64),
}

/// Pure transition over authenticated on-chain observations. Equality is clean.
pub(crate) fn transition(
    config: &CovenantConfig,
    previous: &CovenantState,
    performance: i128,
    funding: i128,
    period_end: u64,
) -> (CovenantState, bool) {
    let breached = performance < config.min_performance || funding < config.min_redemption_funding;
    let mut state = previous.clone();
    state.last_period_end = period_end;
    if breached {
        state.consecutive_clean = 0;
        state.consecutive_breaches = state
            .consecutive_breaches
            .saturating_add(1)
            .min(config.breach_cycles);
        if state.consecutive_breaches >= config.breach_cycles {
            state.stepped_down = true;
        }
    } else {
        state.consecutive_breaches = 0;
        state.consecutive_clean = state
            .consecutive_clean
            .saturating_add(1)
            .min(config.recovery_cycles);
        if state.consecutive_clean >= config.recovery_cycles {
            state.stepped_down = false;
        }
    }
    (state, breached)
}

pub(crate) fn validate_cycle(
    env: &Env,
    bond: u64,
    period: u32,
    report: &Report,
    existing: bool,
) -> Result<(), BondError> {
    if !env
        .storage()
        .instance()
        .has(&CovenantKey::TrancheCovenant(bond))
    {
        return Ok(());
    }
    let count = CouponEngine::get_period_count(env.clone(), bond);
    if period != count {
        return Err(BondError::InvalidCovenant);
    }
    if !existing {
        let previous = CouponEngine::get_covenant_state(env.clone(), bond);
        if report.period_start < previous.last_period_end
            || report.period_end <= report.period_start
        {
            return Err(BondError::InvalidCovenant);
        }
    }
    Ok(())
}

pub(crate) fn apply_terms(
    env: &Env,
    bond: u64,
    period: u32,
    report: &Report,
    carbon: i128,
    biodiversity: i128,
) -> Result<(i128, i128), BondError> {
    let config: CovenantConfig = match env
        .storage()
        .instance()
        .get(&CovenantKey::TrancheCovenant(bond))
    {
        Some(config) => config,
        None => return Ok((carbon, biodiversity)),
    };
    let cycle_key = CovenantKey::TrancheCovenantCycle(bond, period);
    if let Some(cycle) = CouponEngine::get_covenant_cycle(env.clone(), bond, period) {
        if cycle.report_id != report.id {
            return Err(BondError::InvalidCovenant);
        }
        return Ok((cycle.carbon_pool, cycle.biodiversity_pool));
    }
    let issuer: Address = env
        .storage()
        .instance()
        .get(&DataKey::BondIssuerAddress)
        .ok_or(BondError::NotInitialized)?;
    let funding: i128 = env.invoke_contract(
        &issuer,
        &Symbol::new(env, "get_redemption_pool"),
        vec![env, bond.into_val(env)],
    );
    let previous = CouponEngine::get_covenant_state(env.clone(), bond);
    let (state, breached) = transition(
        &config,
        &previous,
        report.carbon_sequestered,
        funding,
        report.period_end,
    );
    let coupon_bps = if state.stepped_down {
        config.stepped_coupon_bps
    } else {
        10_000
    };
    let carbon_pool = checked_ratio(carbon, coupon_bps as i128, 10_000)?;
    let biodiversity_pool = checked_ratio(biodiversity, coupon_bps as i128, 10_000)?;
    let cycle = CovenantCycle {
        report_id: report.id,
        performance: report.carbon_sequestered,
        redemption_funding: funding,
        breached,
        state: state.clone(),
        coupon_bps,
        carbon_pool,
        biodiversity_pool,
    };
    env.storage().persistent().set(&cycle_key, &cycle);
    env.storage().instance().set(
        &CovenantKey::TrancheCovenantLiveCycle(bond),
        &(period, cycle.clone()),
    );
    env.storage()
        .instance()
        .set(&CovenantKey::TrancheCovenantState(bond), &state);
    env.events().publish(
        (Symbol::new(env, "covenant_evaluated"), bond, period),
        cycle,
    );
    Ok((carbon_pool, biodiversity_pool))
}

#[contractimpl]
impl CouponEngine {
    /// Immutable tranche terms: configure after registration, before issuance's
    /// first coupon begins. Evaluation is automatic inside coupon distribution.
    pub fn configure_covenant(
        env: Env,
        caller: Address,
        bond_id: u64,
        config: CovenantConfig,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();
        require_admin(&env, &caller)?;
        if get_nonce(&env, &caller) != nonce {
            return Err(BondError::InvalidNonce);
        }
        if !env.storage().instance().has(&DataKey::BondProject(bond_id)) {
            return Err(BondError::BondNotFound);
        }
        if config.min_performance < 0
            || config.min_redemption_funding < 0
            || config.breach_cycles == 0
            || config.recovery_cycles == 0
            || config.stepped_coupon_bps >= 10_000
            || Self::get_period_count(env.clone(), bond_id) != 0
            || env
                .storage()
                .persistent()
                .has(&DataKey::PeriodInfo(bond_id, 0))
            || env
                .storage()
                .instance()
                .has(&CovenantKey::TrancheCovenant(bond_id))
        {
            return Err(BondError::InvalidCovenant);
        }
        set_nonce(
            &env,
            &caller,
            nonce.checked_add(1).ok_or(BondError::Overflow)?,
        );
        env.storage()
            .instance()
            .set(&CovenantKey::TrancheCovenant(bond_id), &config);
        env.events()
            .publish((Symbol::new(&env, "covenant_configured"), bond_id), config);
        Ok(())
    }

    pub fn get_covenant(env: Env, bond_id: u64) -> Option<CovenantConfig> {
        env.storage()
            .instance()
            .get(&CovenantKey::TrancheCovenant(bond_id))
    }

    pub fn get_covenant_state(env: Env, bond_id: u64) -> CovenantState {
        env.storage()
            .instance()
            .get(&CovenantKey::TrancheCovenantState(bond_id))
            .unwrap_or(CovenantState {
                stepped_down: false,
                consecutive_breaches: 0,
                consecutive_clean: 0,
                last_period_end: 0,
            })
    }

    pub fn get_covenant_cycle(env: Env, bond_id: u64, period_index: u32) -> Option<CovenantCycle> {
        if let Some((period, cycle)) = env
            .storage()
            .instance()
            .get::<_, (u32, CovenantCycle)>(&CovenantKey::TrancheCovenantLiveCycle(bond_id))
        {
            if period == period_index {
                return Some(cycle);
            }
        }
        env.storage()
            .persistent()
            .get(&CovenantKey::TrancheCovenantCycle(bond_id, period_index))
    }
}
