use super::*;

pub const MAX_EQUIVALENCE_ENTRIES: u32 = 32;
pub const MAX_EQUIVALENCE_FACTOR: i128 = 1_000_000_000;

/// Methodology symbols are registry-qualified identifiers matching reports.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct EquivalenceFactor {
    pub methodology: Symbol,
    pub numerator: i128,
    pub denominator: i128,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct EquivalenceTable {
    pub version: u32,
    pub factors: Vec<EquivalenceFactor>,
    pub rationale_hash: BytesN<32>,
    pub published_at: u64,
    pub governance: Address,
}

/// Immutable inputs and final pools for independently replaying a coupon.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct CouponCalculation {
    pub table_version: u32,
    pub report_id: u64,
    pub methodology: Symbol,
    pub raw_carbon: i128,
    pub normalized_carbon: i128,
    pub factor_numerator: i128,
    pub factor_denominator: i128,
    pub carbon_conversion_applied: bool,
    pub staleness_discount_bps: u64,
    pub true_up_amount: i128,
    pub covenant_bps: u32,
    pub carbon_pool: i128,
    pub biodiversity_pool: i128,
    pub balance_version: u64,
    pub total_subscribed: i128,
}

#[derive(Clone)]
#[contracttype]
// Variant prefixes namespace the serialized storage keys without changing the
// engine's existing DataKey schema.
#[allow(clippy::enum_variant_names)]
enum EquivalenceKey {
    CreditEquivalenceGovernance,
    CreditEquivalenceVersion,
    CreditEquivalenceTable(u32),
    CreditCouponCalculation(u64, u32),
    CreditCouponLiveCalculation(u64),
}

/// Version zero is the explicitly recorded legacy identity conversion.
pub(crate) fn conversion(
    env: &Env,
    bond: u64,
    period: u32,
    report: &Report,
    credit_type: CreditType,
) -> Result<CouponCalculation, BondError> {
    if let Some(calculation) = CouponEngine::get_coupon_calculation(env.clone(), bond, period) {
        if calculation.report_id != report.id {
            return Err(BondError::InvalidReport);
        }
        return Ok(calculation);
    }
    // Restore an already-started coupon's historical snapshot instead of
    // inferring a replacement calculation from today's table.
    if env
        .storage()
        .persistent()
        .has(&DataKey::PeriodInfo(bond, period))
    {
        return Err(BondError::InvalidEquivalence);
    }
    if report.carbon_sequestered < 0 {
        return Err(BondError::InvalidReport);
    }
    let version = CouponEngine::get_equivalence_version(env.clone());
    let convert = credit_type != CreditType::Biodiversity;
    let factor = if version == 0 || !convert {
        EquivalenceFactor {
            methodology: report.methodology.clone(),
            numerator: 1,
            denominator: 1,
        }
    } else {
        CouponEngine::get_equivalence_table(env.clone(), version)
            .ok_or(BondError::InvalidEquivalence)?
            .factors
            .iter()
            .find(|factor| factor.methodology == report.methodology)
            .ok_or(BondError::UnknownEquivalence)?
    };
    let normalized = if convert {
        checked_ratio(
            report.carbon_sequestered,
            factor.numerator,
            factor.denominator,
        )?
    } else {
        0
    };
    Ok(CouponCalculation {
        table_version: version,
        report_id: report.id,
        methodology: report.methodology.clone(),
        raw_carbon: report.carbon_sequestered,
        normalized_carbon: normalized,
        factor_numerator: factor.numerator,
        factor_denominator: factor.denominator,
        carbon_conversion_applied: convert,
        staleness_discount_bps: 0,
        true_up_amount: 0,
        covenant_bps: 10_000,
        carbon_pool: 0,
        biodiversity_pool: 0,
        balance_version: 0,
        total_subscribed: 0,
    })
}

pub(crate) fn pin_calculation(
    env: &Env,
    bond: u64,
    period: u32,
    mut calculation: CouponCalculation,
    carbon: i128,
    biodiversity: i128,
    discount: u64,
    true_up: i128,
) -> Result<CouponCalculation, BondError> {
    let key = EquivalenceKey::CreditCouponCalculation(bond, period);
    if let Some(existing) = CouponEngine::get_coupon_calculation(env.clone(), bond, period) {
        return Ok(existing);
    }
    let issuer: Address = env
        .storage()
        .instance()
        .get(&DataKey::BondIssuerAddress)
        .ok_or(BondError::NotInitialized)?;
    calculation.balance_version = env.invoke_contract(
        &issuer,
        &Symbol::new(env, "get_balance_version"),
        vec![env, bond.into_val(env)],
    );
    calculation.total_subscribed = env.invoke_contract(
        &issuer,
        &Symbol::new(env, "total_subscribed_at_version"),
        vec![
            env,
            bond.into_val(env),
            calculation.balance_version.into_val(env),
        ],
    );
    calculation.carbon_pool = carbon;
    calculation.biodiversity_pool = biodiversity;
    calculation.staleness_discount_bps = discount;
    calculation.true_up_amount = true_up;
    calculation.covenant_bps = CouponEngine::get_covenant_cycle(env.clone(), bond, period)
        .map(|cycle| cycle.coupon_bps)
        .unwrap_or(10_000);
    env.storage().persistent().set(&key, &calculation);
    // The latest cycle shares the bond's instance lifetime, so an archived
    // history entry cannot alter an ongoing batch's calculation.
    env.storage().instance().set(
        &EquivalenceKey::CreditCouponLiveCalculation(bond),
        &(period, calculation.clone()),
    );
    env.events().publish(
        (Symbol::new(env, "coupon_calculated"), bond, period),
        calculation.clone(),
    );
    Ok(calculation)
}

#[contractimpl]
impl CouponEngine {
    /// Bind the existing governance contract once. Only its authenticated calls
    /// can publish tables; later admin rotation cannot replace the authority.
    pub fn set_equivalence_governance(
        env: Env,
        caller: Address,
        governance: Address,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();
        require_admin(&env, &caller)?;
        if get_nonce(&env, &caller) != nonce {
            return Err(BondError::InvalidNonce);
        }
        if env
            .storage()
            .instance()
            .has(&EquivalenceKey::CreditEquivalenceGovernance)
            || governance == env.current_contract_address()
        {
            return Err(BondError::InvalidEquivalence);
        }
        set_nonce(
            &env,
            &caller,
            nonce.checked_add(1).ok_or(BondError::Overflow)?,
        );
        env.storage()
            .instance()
            .set(&EquivalenceKey::CreditEquivalenceGovernance, &governance);
        env.events()
            .publish((Symbol::new(&env, "equivalence_governance"),), governance);
        Ok(())
    }

    /// A complete replacement table gets a new immutable version. Expected
    /// version prevents a queued proposal from silently overwriting a newer one.
    pub fn publish_equivalence(
        env: Env,
        caller: Address,
        expected_version: u32,
        factors: Vec<EquivalenceFactor>,
        rationale_hash: BytesN<32>,
        nonce: u64,
    ) -> Result<u32, BondError> {
        caller.require_auth();
        let governance: Address = env
            .storage()
            .instance()
            .get(&EquivalenceKey::CreditEquivalenceGovernance)
            .ok_or(BondError::NotInitialized)?;
        if caller != governance {
            return Err(BondError::Unauthorized);
        }
        if get_nonce(&env, &caller) != nonce {
            return Err(BondError::InvalidNonce);
        }
        let current = Self::get_equivalence_version(env.clone());
        if current != expected_version
            || factors.is_empty()
            || factors.len() > MAX_EQUIVALENCE_ENTRIES
            || rationale_hash == BytesN::from_array(&env, &[0; 32])
        {
            return Err(BondError::InvalidEquivalence);
        }
        for (index, factor) in factors.iter().enumerate() {
            if factor.numerator <= 0
                || factor.denominator <= 0
                || factor.numerator > MAX_EQUIVALENCE_FACTOR
                || factor.denominator > MAX_EQUIVALENCE_FACTOR
            {
                return Err(BondError::InvalidEquivalence);
            }
            for previous in 0..index as u32 {
                if factors.get(previous).unwrap().methodology == factor.methodology {
                    return Err(BondError::InvalidEquivalence);
                }
            }
        }
        let version = current.checked_add(1).ok_or(BondError::Overflow)?;
        let table = EquivalenceTable {
            version,
            factors,
            rationale_hash,
            published_at: env.ledger().timestamp(),
            governance,
        };
        set_nonce(
            &env,
            &caller,
            nonce.checked_add(1).ok_or(BondError::Overflow)?,
        );
        env.storage()
            .persistent()
            .set(&EquivalenceKey::CreditEquivalenceTable(version), &table);
        env.storage()
            .instance()
            .set(&EquivalenceKey::CreditEquivalenceVersion, &version);
        env.events()
            .publish((Symbol::new(&env, "equivalence_published"), version), table);
        Ok(version)
    }

    pub fn get_equivalence_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&EquivalenceKey::CreditEquivalenceVersion)
            .unwrap_or(0)
    }

    pub fn get_equivalence_table(env: Env, version: u32) -> Option<EquivalenceTable> {
        env.storage()
            .persistent()
            .get(&EquivalenceKey::CreditEquivalenceTable(version))
    }

    pub fn get_coupon_calculation(
        env: Env,
        bond_id: u64,
        period_index: u32,
    ) -> Option<CouponCalculation> {
        if let Some((period, calculation)) =
            env.storage().instance().get::<_, (u32, CouponCalculation)>(
                &EquivalenceKey::CreditCouponLiveCalculation(bond_id),
            )
        {
            if period == period_index {
                return Some(calculation);
            }
        }
        env.storage()
            .persistent()
            .get(&EquivalenceKey::CreditCouponCalculation(
                bond_id,
                period_index,
            ))
    }

    /// Replay the normalization from the recorded factor, including version 0.
    pub fn replay_coupon_conversion(
        env: Env,
        bond_id: u64,
        period_index: u32,
    ) -> Result<i128, BondError> {
        let calculation = Self::get_coupon_calculation(env, bond_id, period_index)
            .ok_or(BondError::InvalidEquivalence)?;
        if !calculation.carbon_conversion_applied {
            return Ok(0);
        }
        checked_ratio(
            calculation.raw_carbon,
            calculation.factor_numerator,
            calculation.factor_denominator,
        )
    }
}
