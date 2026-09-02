#![no_std]
#![allow(deprecated)]
use nbbs_shared::{BondConfig, BondError, BondStatus, CreditType, RedemptionCoverage};
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Env, IntoVal, Symbol};

pub const MAX_SUPPLY: i128 = 1_000_000_000_000_000_000;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    BondConfig(u64),
    BondState(u64),
    HolderBalance(u64, Address),
    RedemptionPool(u64),
    BondCount,
    Nonce(Address),
    ProjectRegistry,
}

#[derive(Clone, Debug)]
#[contracttype]
pub struct BondState {
    pub total_subscribed: i128,
    pub status: BondStatus,
    pub created_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct PreviewSubscription {
    pub remaining_supply: i128,
    pub requested_amount: i128,
    pub expected_failure: Option<BondError>,
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

fn consume_nonce(env: &Env, addr: &Address, nonce: u64) -> Result<(), BondError> {
    let expected_nonce: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::Nonce(addr.clone()))
        .unwrap_or(0);
    if nonce != expected_nonce {
        return Err(BondError::InvalidNonce);
    }
    env.storage()
        .persistent()
        .set(&DataKey::Nonce(addr.clone()), &(expected_nonce + 1));
    Ok(())
}

/// Classifies a methodology symbol against a credit type (Issue #146).
///
/// Methodologies are free-form symbols in the wider ecosystem
/// ("VCS", "verra_vcs", "GS", "blue_carbon", "BLUE-CARBON", ...), so rather
/// than an exact-enum string set that would drift from registry values, we
/// treat Carbon as the broad default and only gate the specialised credit
/// types (BlueCarbon, Biodiversity) on an explicit marker in the methodology.
/// This keeps issuance permissive for carbon-heavy registries while still
/// rejecting clearly incompatible pairings and is therefore robust to the
/// case/underscore variance already present in fixtures.
fn methodology_compatible(env: &Env, methodology: &Symbol, credit_type: &CreditType) -> bool {
    use CreditType::*;
    let blue = [
        Symbol::new(env, "blue_carbon"),
        Symbol::new(env, "BLUE_CARBON"),
        Symbol::new(env, "BLUE"),
    ];
    let biodiv = [
        Symbol::new(env, "biodiversity"),
        Symbol::new(env, "BIODIVERSITY"),
        Symbol::new(env, "biodiv"),
    ];
    let is_blue = blue.contains(methodology);
    let is_biodiv = biodiv.contains(methodology);
    match credit_type {
        Carbon => !is_blue && !is_biodiv,
        BlueCarbon => is_blue,
        Biodiversity => is_biodiv,
        // A basket bundle is intentionally multi-asset and accepts any backing
        // methodology; downstream coupon distribution resolves per-report.
        Basket => true,
    }
}

#[contract]
pub struct BondIssuer;

#[contractimpl]
impl BondIssuer {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn set_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), BondError> {
        current_admin.require_auth();
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

    pub fn set_project_registry(
        env: Env,
        caller: Address,
        registry: Address,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();
        consume_nonce(&env, &caller, nonce)?;
        require_admin(&env, &caller)?;

        env.storage()
            .instance()
            .set(&DataKey::ProjectRegistry, &registry);

        Ok(())
    }

    pub fn issue_bond(
        env: Env,
        caller: Address,
        config: BondConfig,
        nonce: u64,
    ) -> Result<u64, BondError> {
        caller.require_auth();
        consume_nonce(&env, &caller, nonce)?;
        require_admin(&env, &caller)?;

        if config.face_value <= 0 {
            return Err(BondError::ZeroAmount);
        }
        // Bound supply so downstream fixed-point coupon math can multiply
        // supply by per-token precision without approaching i128 limits.
        if config.total_supply <= 0 || config.total_supply > MAX_SUPPLY {
            return Err(BondError::InvalidSupply);
        }
        if config.maturity_date <= env.ledger().timestamp() {
            return Err(BondError::Overflow);
        }

        let schedule_len = config.coupon_schedule.len();
        if schedule_len == 0 {
            return Err(BondError::ZeroAmount);
        }
        for i in 0..schedule_len {
            let coupon_date = config.coupon_schedule.get(i).unwrap();
            if coupon_date >= config.maturity_date {
                return Err(BondError::ZeroAmount);
            }
        }

        if let Some(registry) = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::ProjectRegistry)
        {
            let approved: bool = env.invoke_contract(
                &registry,
                &Symbol::new(&env, "has_approved_project"),
                vec![&env, config.project_id.clone().into_val(&env)],
            );
            if !approved {
                return Err(BondError::ProjectNotApproved);
            }

            // Issue #146: the backing project's methodology must be compatible
            // with the bond's coupon credit denomination. Cross-invoke the
            // registry to fetch the methodology and compare against the agreed
            // methodology -> credit-type matrix.
            let methodology: Symbol = env.invoke_contract(
                &registry,
                &Symbol::new(&env, "get_project_methodology"),
                vec![&env, config.project_id.clone().into_val(&env)],
            );
            if !methodology_compatible(&env, &methodology, &config.credit_type) {
                return Err(BondError::IncompatibleMethodologyCreditType);
            }
        }

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::BondCount)
            .unwrap_or(0);
        let bond_id = count + 1;
        env.storage().instance().set(&DataKey::BondCount, &bond_id);

        env.storage()
            .instance()
            .set(&DataKey::BondConfig(bond_id), &config);

        let state = BondState {
            total_subscribed: 0,
            status: BondStatus::Active,
            created_at: env.ledger().timestamp(),
        };
        env.storage()
            .instance()
            .set(&DataKey::BondState(bond_id), &state);

        env.events().publish(
            (Symbol::new(&env, "bond_issued"),),
            (bond_id, config.project_id),
        );

        Ok(bond_id)
    }

    pub fn subscribe(
        env: Env,
        investor: Address,
        bond_id: u64,
        amount: i128,
        nonce: u64,
    ) -> Result<(), BondError> {
        investor.require_auth();
        consume_nonce(&env, &investor, nonce)?;

        if amount <= 0 {
            return Err(BondError::ZeroAmount);
        }

        let config: BondConfig = env
            .storage()
            .instance()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let mut state: BondState = env
            .storage()
            .instance()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;

        if state.status != BondStatus::Active {
            return Err(BondError::BondAlreadyMatured);
        }

        if env.ledger().timestamp() >= config.maturity_date {
            return Err(BondError::BondAlreadyMatured);
        }

        let new_total = state
            .total_subscribed
            .checked_add(amount)
            .ok_or(BondError::Overflow)?;
        if new_total > config.total_supply {
            return Err(BondError::InsufficientSupply);
        }

        let balance_key = DataKey::HolderBalance(bond_id, investor.clone());
        let current_balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        let new_balance = current_balance
            .checked_add(amount)
            .ok_or(BondError::Overflow)?;
        env.storage().persistent().set(&balance_key, &new_balance);

        state.total_subscribed = new_total;
        env.storage()
            .instance()
            .set(&DataKey::BondState(bond_id), &state);

        env.events().publish(
            (Symbol::new(&env, "subscribed"),),
            (bond_id, investor, amount),
        );

        Ok(())
    }

    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        bond_id: u64,
        amount: i128,
        nonce: u64,
    ) -> Result<(), BondError> {
        from.require_auth();
        consume_nonce(&env, &from, nonce)?;

        if to == from {
            return Err(BondError::Unauthorized);
        }
        if amount <= 0 {
            return Err(BondError::ZeroAmount);
        }

        let config: BondConfig = env
            .storage()
            .instance()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let state: BondState = env
            .storage()
            .instance()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;
        if state.status != BondStatus::Active {
            return Err(BondError::BondAlreadyMatured);
        }

        if env.ledger().timestamp() >= config.maturity_date {
            return Err(BondError::BondAlreadyMatured);
        }

        let from_key = DataKey::HolderBalance(bond_id, from.clone());
        let from_balance: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        if from_balance < amount {
            return Err(BondError::InsufficientSupply);
        }

        let new_from_balance = from_balance
            .checked_sub(amount)
            .ok_or(BondError::Overflow)?;
        env.storage().persistent().set(&from_key, &new_from_balance);

        let to_key = DataKey::HolderBalance(bond_id, to.clone());
        let to_balance: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        let new_to_balance = to_balance.checked_add(amount).ok_or(BondError::Overflow)?;
        env.storage().persistent().set(&to_key, &new_to_balance);

        env.events().publish(
            (Symbol::new(&env, "transferred"),),
            (bond_id, from, to, amount),
        );

        Ok(())
    }

    pub fn fund_redemption(
        env: Env,
        caller: Address,
        bond_id: u64,
        amount: i128,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();
        consume_nonce(&env, &caller, nonce)?;
        require_admin(&env, &caller)?;
        if amount <= 0 {
            return Err(BondError::ZeroAmount);
        }
        let _config: BondConfig = env
            .storage()
            .instance()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let key = DataKey::RedemptionPool(bond_id);
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let next = current.checked_add(amount).ok_or(BondError::Overflow)?;
        env.storage().persistent().set(&key, &next);
        env.events().publish(
            (Symbol::new(&env, "redemption_funded"),),
            (bond_id, caller, amount),
        );
        Ok(())
    }

    pub fn redeem(
        env: Env,
        holder: Address,
        bond_id: u64,
        amount: i128,
        nonce: u64,
    ) -> Result<(), BondError> {
        holder.require_auth();
        consume_nonce(&env, &holder, nonce)?;

        if amount <= 0 {
            return Err(BondError::ZeroAmount);
        }

        let mut state: BondState = env
            .storage()
            .instance()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;
        let config: BondConfig = env
            .storage()
            .instance()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;

        if state.status != BondStatus::Matured {
            return Err(BondError::BondAlreadyMatured);
        }

        let balance_key = DataKey::HolderBalance(bond_id, holder.clone());
        let current_balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        if current_balance < amount {
            return Err(BondError::InsufficientSupply);
        }
        let payout = amount
            .checked_mul(config.face_value)
            .ok_or(BondError::Overflow)?;
        let pool_key = DataKey::RedemptionPool(bond_id);
        let pool: i128 = env.storage().persistent().get(&pool_key).unwrap_or(0);
        if pool < payout {
            return Err(BondError::RedemptionUnderfunded);
        }
        env.storage().persistent().set(&pool_key, &(pool - payout));

        let new_balance = current_balance
            .checked_sub(amount)
            .ok_or(BondError::Overflow)?;
        env.storage().persistent().set(&balance_key, &new_balance);

        state.total_subscribed = state
            .total_subscribed
            .checked_sub(amount)
            .ok_or(BondError::Overflow)?;
        env.storage()
            .instance()
            .set(&DataKey::BondState(bond_id), &state);

        env.events().publish(
            (Symbol::new(&env, "redeemed"),),
            (bond_id, holder, amount, payout),
        );

        Ok(())
    }

    pub fn get_bond(env: Env, bond_id: u64) -> Result<BondConfig, BondError> {
        env.storage()
            .instance()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)
    }

    pub fn get_bond_state(env: Env, bond_id: u64) -> Result<BondState, BondError> {
        env.storage()
            .instance()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)
    }

    pub fn get_holder_balance(env: Env, bond_id: u64, holder: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::HolderBalance(bond_id, holder))
            .unwrap_or(0)
    }

    pub fn get_redemption_pool(env: Env, bond_id: u64) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::RedemptionPool(bond_id))
            .unwrap_or(0)
    }

    /// Per-holder unpaid principal liability before/at redemption (Issue #150):
    /// the holder's outstanding subscription balance scaled by face value.
    pub fn holder_redemption_liability(env: Env, bond_id: u64, holder: Address) -> i128 {
        let balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::HolderBalance(bond_id, holder.clone()))
            .unwrap_or(0);
        if balance == 0 {
            return 0;
        }
        let config: BondConfig = env
            .storage()
            .instance()
            .get(&DataKey::BondConfig(bond_id))
            .unwrap();
        balance.saturating_mul(config.face_value)
    }

    /// Aggregate redemption funding coverage for a bond (Issue #150): total
    /// principal due across all holders, funded amount, and shortfall.
    pub fn redemption_coverage(env: Env, bond_id: u64) -> Result<RedemptionCoverage, BondError> {
        let config: BondConfig = env
            .storage()
            .instance()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;
        let state: BondState = env
            .storage()
            .instance()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let total_principal_due = state
            .total_subscribed
            .checked_mul(config.face_value)
            .ok_or(BondError::Overflow)?;
        let funded_amount = env
            .storage()
            .persistent()
            .get(&DataKey::RedemptionPool(bond_id))
            .unwrap_or(0);
        let shortfall = if total_principal_due > funded_amount {
            total_principal_due - funded_amount
        } else {
            0
        };
        let coverage_fraction_bps = if total_principal_due == 0 {
            10000
        } else {
            let numerator = (funded_amount as u128).saturating_mul(10000);
            (numerator / total_principal_due as u128).min(10000) as u64
        };

        Ok(RedemptionCoverage {
            total_principal_due,
            funded_amount,
            shortfall,
            coverage_fraction_bps,
        })
    }

    pub fn get_nonce(env: Env, address: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::Nonce(address))
            .unwrap_or(0)
    }

    pub fn total_supply(env: Env, bond_id: u64) -> Result<i128, BondError> {
        let config: BondConfig = env
            .storage()
            .instance()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;
        Ok(config.total_supply)
    }

    pub fn total_subscribed(env: Env, bond_id: u64) -> Result<i128, BondError> {
        let state: BondState = env
            .storage()
            .instance()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;
        Ok(state.total_subscribed)
    }

    pub fn bond_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::BondCount)
            .unwrap_or(0)
    }

    pub fn mature_bond(
        env: Env,
        caller: Address,
        bond_id: u64,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();
        consume_nonce(&env, &caller, nonce)?;
        require_admin(&env, &caller)?;

        let config: BondConfig = env
            .storage()
            .instance()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let mut state: BondState = env
            .storage()
            .instance()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;

        if state.status != BondStatus::Active {
            return Err(BondError::BondAlreadyMatured);
        }

        if env.ledger().timestamp() < config.maturity_date {
            return Err(BondError::Overflow);
        }

        state.status = BondStatus::Matured;
        env.storage()
            .instance()
            .set(&DataKey::BondState(bond_id), &state);

        env.events()
            .publish((Symbol::new(&env, "bond_matured"),), (bond_id,));

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, vec, BytesN};

    fn create_project_id(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[31] = value;
        BytesN::from_array(env, &arr)
    }

    fn make_config(env: &Env) -> BondConfig {
        BondConfig {
            project_id: create_project_id(env, 1),
            face_value: 1000,
            coupon_schedule: vec![&env, 1000000u64, 2000000u64],
            credit_type: nbbs_shared::CreditType::Carbon,
            maturity_date: 3000000,
            total_supply: 10000,
        }
    }

    fn setup() -> (Env, BondIssuerClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let contract_id = env.register(BondIssuer, (&admin,));
        let client = BondIssuerClient::new(&env, &contract_id);
        (env, client, admin, user)
    }

    #[test]
    fn test_issue_bond() {
        let (env, client, admin, _user) = setup();
        let config = make_config(&env);

        let bond_id = client.issue_bond(&admin, &config, &0);
        assert_eq!(bond_id, 1);

        let stored = client.get_bond(&bond_id);
        assert_eq!(stored.face_value, 1000);
        assert_eq!(stored.total_supply, 10000);
        assert_eq!(stored.maturity_date, 3000000);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.total_subscribed, 0);
        assert_eq!(state.status, BondStatus::Active);
    }

    #[test]
    fn test_issue_bond_past_maturity() {
        let (env, client, admin, _user) = setup();
        env.ledger().set_timestamp(1000);
        let mut config = make_config(&env);
        config.maturity_date = 500;

        let result = client.try_issue_bond(&admin, &config, &0);
        assert_eq!(result, Err(Ok(BondError::Overflow)));
    }

    #[test]
    fn test_issue_bond_empty_schedule() {
        let (env, client, admin, _user) = setup();
        let mut config = make_config(&env);
        config.coupon_schedule = vec![&env];

        let result = client.try_issue_bond(&admin, &config, &0);
        assert_eq!(result, Err(Ok(BondError::ZeroAmount)));
    }

    #[test]
    fn test_issue_bond_enforces_supply_bounds() {
        let (env, client, admin, _user) = setup();

        let mut max_config = make_config(&env);
        max_config.total_supply = MAX_SUPPLY;
        assert_eq!(client.issue_bond(&admin, &max_config, &0), 1);

        let mut above_max = make_config(&env);
        above_max.total_supply = MAX_SUPPLY + 1;
        assert_eq!(
            client.try_issue_bond(&admin, &above_max, &1),
            Err(Ok(BondError::InvalidSupply))
        );

        let mut zero = make_config(&env);
        zero.total_supply = 0;
        assert_eq!(
            client.try_issue_bond(&admin, &zero, &1),
            Err(Ok(BondError::InvalidSupply))
        );
    }

    #[test]
    fn test_admin_rotation_gates_admin_functions() {
        let (env, client, admin, _user) = setup();
        let new_admin = Address::generate(&env);
        let config = make_config(&env);

        client.set_admin(&admin, &new_admin);
        assert_eq!(client.get_admin(), new_admin);

        assert_eq!(
            client.try_issue_bond(&admin, &config, &0),
            Err(Ok(BondError::Unauthorized))
        );
        assert_eq!(client.issue_bond(&new_admin, &config, &0), 1);
    }

    #[test]
    fn test_subscribe_partial() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &500, &0);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.total_subscribed, 500);

        let balance = client.get_holder_balance(&bond_id, &user);
        assert_eq!(balance, 500);
    }

    #[test]
    fn test_subscribe_full() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &10000, &0);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.total_subscribed, 10000);
    }

    #[test]
    fn test_subscribe_exceeds_supply() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        let result = client.try_subscribe(&user, &bond_id, &10001, &0);
        assert_eq!(result, Err(Ok(BondError::InsufficientSupply)));
    }

    #[test]
    fn test_subscribe_zero_amount() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        let result = client.try_subscribe(&user, &bond_id, &0, &0);
        assert_eq!(result, Err(Ok(BondError::ZeroAmount)));
    }

    #[test]
    fn test_subscribe_non_existent_bond() {
        let (_env, client, _admin, user) = setup();
        let result = client.try_subscribe(&user, &999, &500, &0);
        assert_eq!(result, Err(Ok(BondError::BondNotFound)));
    }

    #[test]
    fn test_mature_bond() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &5000, &0);
        env.ledger().set_timestamp(config.maturity_date);
        client.mature_bond(&admin, &bond_id, &1);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.status, BondStatus::Matured);
    }

    #[test]
    fn test_mature_bond_before_maturity_rejected() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &5000, &0);
        env.ledger().set_timestamp(config.maturity_date - 1);

        let result = client.try_mature_bond(&admin, &bond_id, &1);
        assert_eq!(result, Err(Ok(BondError::Overflow)));

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.status, BondStatus::Active);
    }

    #[test]
    fn test_subscribe_after_maturity_date_rejected() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        env.ledger().set_timestamp(config.maturity_date);

        let result = client.try_subscribe(&user, &bond_id, &1000, &0);
        assert_eq!(result, Err(Ok(BondError::BondAlreadyMatured)));
    }

    #[test]
    fn test_transfer_after_maturity_date_rejected() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        env.ledger().set_timestamp(config.maturity_date);

        let result = client.try_transfer(&user, &user2, &bond_id, &100, &1);
        assert_eq!(result, Err(Ok(BondError::BondAlreadyMatured)));
    }

    #[test]
    fn test_redeem_after_maturity() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &3000, &0);
        env.ledger().set_timestamp(config.maturity_date);
        client.mature_bond(&admin, &bond_id, &1);
        client.fund_redemption(&admin, &bond_id, &1_000_000, &2);

        client.redeem(&user, &bond_id, &1000, &1);

        let balance = client.get_holder_balance(&bond_id, &user);
        assert_eq!(balance, 2000);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.total_subscribed, 2000);
        assert_eq!(client.get_redemption_pool(&bond_id), 0);
    }

    #[test]
    fn test_redeem_requires_funded_principal_pool() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        env.ledger().set_timestamp(config.maturity_date);
        client.mature_bond(&admin, &bond_id, &1);
        client.fund_redemption(&admin, &bond_id, &999_999, &2);

        let result = client.try_redeem(&user, &bond_id, &1000, &1);
        assert_eq!(result, Err(Ok(BondError::RedemptionUnderfunded)));
        assert_eq!(client.get_holder_balance(&bond_id, &user), 1000);
        assert_eq!(client.get_redemption_pool(&bond_id), 999_999);
    }

    #[test]
    fn test_redemption_coverage_partial_shortfall() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env); // face_value 1000
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &3000, &0); // liability = 3_000_000
        client.fund_redemption(&admin, &bond_id, &1_000_000, &1);

        let cov = client.redemption_coverage(&bond_id);
        assert_eq!(cov.total_principal_due, 3_000_000);
        assert_eq!(cov.funded_amount, 1_000_000);
        assert_eq!(cov.shortfall, 2_000_000);
        // 1_000_000 / 3_000_000 = 33.33% -> 3333 bps
        assert_eq!(cov.coverage_fraction_bps, 3333);

        assert_eq!(
            client.holder_redemption_liability(&bond_id, &user),
            3_000_000
        );
    }

    #[test]
    fn test_redemption_coverage_fully_funded() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &3000, &0);
        client.fund_redemption(&admin, &bond_id, &3_000_000, &1);

        let cov = client.redemption_coverage(&bond_id);
        assert_eq!(cov.funded_amount, 3_000_000);
        assert_eq!(cov.shortfall, 0);
        assert_eq!(cov.coverage_fraction_bps, 10000);
    }

    #[test]
    fn test_redemption_coverage_overfunded_saturates() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        client.fund_redemption(&admin, &bond_id, &5_000_000, &1);

        let cov = client.redemption_coverage(&bond_id);
        assert_eq!(cov.total_principal_due, 1_000_000);
        assert_eq!(cov.funded_amount, 5_000_000);
        assert_eq!(cov.shortfall, 0);
        assert_eq!(cov.coverage_fraction_bps, 10000);
    }

    #[test]
    fn test_redemption_coverage_no_subscriptions_is_full() {
        let (env, client, admin, _user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        let cov = client.redemption_coverage(&bond_id);
        assert_eq!(cov.total_principal_due, 0);
        assert_eq!(cov.shortfall, 0);
        assert_eq!(cov.coverage_fraction_bps, 10000);
    }

    #[test]
    fn test_redeem_before_maturity() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &3000, &0);

        let result = client.try_redeem(&user, &bond_id, &1000, &1);
        assert_eq!(result, Err(Ok(BondError::BondAlreadyMatured)));
    }

    #[test]
    fn test_redeem_more_than_owned() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        env.ledger().set_timestamp(config.maturity_date);
        client.mature_bond(&admin, &bond_id, &1);

        let result = client.try_redeem(&user, &bond_id, &2000, &1);
        assert_eq!(result, Err(Ok(BondError::InsufficientSupply)));
    }

    #[test]
    fn test_invalid_nonce() {
        let (env, client, admin, _user) = setup();
        let config = make_config(&env);

        let result = client.try_issue_bond(&admin, &config, &1);
        assert_eq!(result, Err(Ok(BondError::InvalidNonce)));
    }

    #[test]
    fn test_unauthorized() {
        let (env, client, _admin, user) = setup();
        let config = make_config(&env);

        let result = client.try_issue_bond(&user, &config, &0);
        assert_eq!(result, Err(Ok(BondError::Unauthorized)));
    }

    #[test]
    fn test_multiple_investors() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &2000, &0);
        client.subscribe(&user2, &bond_id, &3000, &0);

        assert_eq!(client.get_holder_balance(&bond_id, &user), 2000);
        assert_eq!(client.get_holder_balance(&bond_id, &user2), 3000);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.total_subscribed, 5000);
    }

    #[test]
    fn test_total_supply_and_subscribed() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        assert_eq!(client.total_supply(&bond_id), 10000);
        assert_eq!(client.total_subscribed(&bond_id), 0);

        client.subscribe(&user, &bond_id, &4000, &0);
        assert_eq!(client.total_subscribed(&bond_id), 4000);
    }

    #[test]
    fn test_transfer() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        client.transfer(&user, &user2, &bond_id, &600, &1);

        assert_eq!(client.get_holder_balance(&bond_id, &user), 400);
        assert_eq!(client.get_holder_balance(&bond_id, &user2), 600);

        let state = client.get_bond_state(&bond_id);
        assert_eq!(state.total_subscribed, 1000);
    }

    #[test]
    fn test_transfer_reused_nonce_is_rejected() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        client.transfer(&user, &user2, &bond_id, &100, &1);

        let result = client.try_transfer(&user, &user2, &bond_id, &100, &1);
        assert_eq!(result, Err(Ok(BondError::InvalidNonce)));
    }

    #[test]
    fn test_transfer_partial_keeps_source() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        client.subscribe(&user2, &bond_id, &500, &0);
        client.transfer(&user, &user2, &bond_id, &250, &1);

        assert_eq!(client.get_holder_balance(&bond_id, &user), 750);
        assert_eq!(client.get_holder_balance(&bond_id, &user2), 750);
    }

    #[test]
    fn test_transfer_more_than_owned() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &500, &0);

        let result = client.try_transfer(&user, &user2, &bond_id, &600, &1);
        assert_eq!(result, Err(Ok(BondError::InsufficientSupply)));
    }

    #[test]
    fn test_transfer_from_non_holder() {
        let (env, client, admin, _user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        let result = client.try_transfer(&user2, &Address::generate(&env), &bond_id, &100, &0);
        assert_eq!(result, Err(Ok(BondError::InsufficientSupply)));
    }

    #[test]
    fn test_transfer_self_rejected() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &500, &0);

        let result = client.try_transfer(&user, &user, &bond_id, &100, &1);
        assert_eq!(result, Err(Ok(BondError::Unauthorized)));
    }

    #[test]
    fn test_transfer_zero_amount() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &500, &0);

        let result = client.try_transfer(&user, &user2, &bond_id, &0, &1);
        assert_eq!(result, Err(Ok(BondError::ZeroAmount)));
    }

    #[test]
    fn test_transfer_nonexistent_bond() {
        let (_env, client, _admin, user) = setup();
        let user2 = Address::generate(&_env);
        let result = client.try_transfer(&user, &user2, &999, &100, &0);
        assert_eq!(result, Err(Ok(BondError::BondNotFound)));
    }

    #[test]
    fn test_transfer_matured_bond_rejected() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        env.ledger().set_timestamp(config.maturity_date);
        client.mature_bond(&admin, &bond_id, &1);

        let result = client.try_transfer(&user, &user2, &bond_id, &100, &1);
        assert_eq!(result, Err(Ok(BondError::BondAlreadyMatured)));
    }

    #[test]
    fn test_transfer_into_accumulated_balance() {
        let (env, client, admin, user) = setup();
        let user2 = Address::generate(&env);
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        client.subscribe(&user, &bond_id, &1000, &0);
        client.subscribe(&user2, &bond_id, &300, &0);
        client.transfer(&user, &user2, &bond_id, &700, &1);

        assert_eq!(client.get_holder_balance(&bond_id, &user), 300);
        assert_eq!(client.get_holder_balance(&bond_id, &user2), 1000);
    }

    #[test]
    fn test_bond_count() {
        let (env, client, admin, _user) = setup();
        assert_eq!(client.bond_count(), 0);

        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);
        assert_eq!(bond_id, 1);
        assert_eq!(client.bond_count(), 1);

        client.issue_bond(&admin, &config, &1);
        assert_eq!(client.bond_count(), 2);
    }

    mod property {
        extern crate std;

        use super::*;
        use proptest::prelude::*;

        proptest! {
            #![proptest_config(ProptestConfig {
                cases: 64,
                ..ProptestConfig::default()
            })]

            // Supply conservation: through an arbitrary sequence of subscriptions
            // and transfers the sum of holder balances always equals
            // total_subscribed, never exceeds total_supply, and each balance is
            // non-negative.
            #[test]
            fn subscription_conserves_supply(
                supply in 100i128..1_000_000i128,
                subscribe_amounts in proptest::collection::vec(1i128..50_000i128, 0..20),
                transfer_amounts in proptest::collection::vec(1i128..50_000i128, 0..20),
            ) {
                let env = Env::default();
                env.mock_all_auths();
                let admin = Address::generate(&env);
                let users: std::vec::Vec<Address> =
                    (0..3).map(|_| Address::generate(&env)).collect();
                let contract_id = env.register(BondIssuer, (&admin,));
                let client = BondIssuerClient::new(&env, &contract_id);

                let mut config = make_config(&env);
                config.total_supply = supply;
                let bond_id = client.issue_bond(&admin, &config, &0);

                let mut balances = [0i128; 3];
                let mut total_subscribed = 0i128;
                let mut nonces = [0u64; 3];

                for (i, &amount) in subscribe_amounts.iter().enumerate() {
                    let u = i % 3;
                    if amount <= supply - total_subscribed {
                        client.subscribe(&users[u], &bond_id, &amount, &nonces[u]);
                        nonces[u] += 1;
                        total_subscribed += amount;
                        balances[u] += amount;
                    } else {
                        let res = client.try_subscribe(&users[u], &bond_id, &amount, &nonces[u]);
                        prop_assert_eq!(res, Err(Ok(BondError::InsufficientSupply)));
                    }
                    let sum: i128 = balances.iter().sum();
                    prop_assert_eq!(sum, total_subscribed);
                    prop_assert!(total_subscribed <= supply);
                    for b in &balances {
                        prop_assert!(*b >= 0);
                    }
                }
                prop_assert_eq!(client.total_subscribed(&bond_id), total_subscribed);

                for (i, &amount) in transfer_amounts.iter().enumerate() {
                    let from = i % 3;
                    let to = (i + 1) % 3;
                    if amount <= balances[from] {
                        client.transfer(&users[from], &users[to], &bond_id, &amount, &nonces[from]);
                        nonces[from] += 1;
                        balances[from] -= amount;
                        balances[to] += amount;
                    } else {
                        let res =
                            client.try_transfer(&users[from], &users[to], &bond_id, &amount, &nonces[from]);
                        prop_assert_eq!(res, Err(Ok(BondError::InsufficientSupply)));
                    }
                    let sum: i128 = balances.iter().sum();
                    prop_assert_eq!(sum, total_subscribed);
                    prop_assert_eq!(client.total_subscribed(&bond_id), total_subscribed);
                    for b in &balances {
                        prop_assert!(*b >= 0);
                    }
                    for (u, &bal) in balances.iter().enumerate() {
                        prop_assert_eq!(client.get_holder_balance(&bond_id, &users[u]), bal);
                    }
                }
            }

            // Subscription/maturity state machine: Active permits subscribe and
            // transfer, only the admin can mature and only at/after maturity_date,
            // and after Matured subscribe/transfer are locked while redeem burns
            // balances in lockstep with total_subscribed.
            #[test]
            fn maturity_state_machine(
                supply in 100i128..100_000i128,
                subscribe_amounts in proptest::collection::vec(1i128..10_000i128, 1..8),
            ) {
                let env = Env::default();
                env.mock_all_auths();
                let admin = Address::generate(&env);
                let users: std::vec::Vec<Address> =
                    (0..3).map(|_| Address::generate(&env)).collect();
                let contract_id = env.register(BondIssuer, (&admin,));
                let client = BondIssuerClient::new(&env, &contract_id);

                let mut config = make_config(&env);
                config.total_supply = supply;
                let bond_id = client.issue_bond(&admin, &config, &0);

                let mut balances = [0i128; 3];
                let mut total_subscribed = 0i128;
                let mut nonces = [0u64; 3];
                for (i, &amount) in subscribe_amounts.iter().enumerate() {
                    let u = i % 3;
                    let capped = amount.min(supply - total_subscribed);
                    if capped <= 0 {
                        break;
                    }
                    client.subscribe(&users[u], &bond_id, &capped, &nonces[u]);
                    nonces[u] += 1;
                    total_subscribed += capped;
                    balances[u] += capped;
                }

                let res = client.try_mature_bond(&admin, &bond_id, &1);
                prop_assert_eq!(res, Err(Ok(BondError::Overflow)));
                prop_assert_eq!(
                    client.get_bond_state(&bond_id).status,
                    BondStatus::Active
                );

                if total_subscribed < supply {
                    client.subscribe(&users[0], &bond_id, &1, &nonces[0]);
                    nonces[0] += 1;
                    total_subscribed += 1;
                    balances[0] += 1;
                }

                env.ledger().set_timestamp(config.maturity_date);
                client.mature_bond(&admin, &bond_id, &1);
                client.fund_redemption(
                    &admin,
                    &bond_id,
                    &(total_subscribed * config.face_value),
                    &2,
                );
                prop_assert_eq!(
                    client.get_bond_state(&bond_id).status,
                    BondStatus::Matured
                );

                let res = client.try_subscribe(&users[1], &bond_id, &1, &nonces[1]);
                prop_assert_eq!(res, Err(Ok(BondError::BondAlreadyMatured)));
                let res = client.try_transfer(&users[0], &users[1], &bond_id, &1, &nonces[0]);
                prop_assert_eq!(res, Err(Ok(BondError::BondAlreadyMatured)));
                let res = client.try_mature_bond(&admin, &bond_id, &3);
                prop_assert_eq!(res, Err(Ok(BondError::BondAlreadyMatured)));

                let amount = balances[0].min(supply);
                if amount > 0 {
                    client.redeem(&users[0], &bond_id, &amount, &nonces[0]);
                    nonces[0] += 1;
                    balances[0] -= amount;
                    total_subscribed -= amount;
                    prop_assert_eq!(client.total_subscribed(&bond_id), total_subscribed);
                    prop_assert_eq!(
                        client.get_holder_balance(&bond_id, &users[0]),
                        balances[0]
                    );

                    let res = client.try_redeem(
                        &users[0],
                        &bond_id,
                        &(balances[0] + 1),
                        &nonces[0],
                    );
                    prop_assert_eq!(res, Err(Ok(BondError::InsufficientSupply)));
                }

                let sum: i128 = balances.iter().sum();
                prop_assert_eq!(sum, total_subscribed);
                prop_assert_eq!(client.total_subscribed(&bond_id), total_subscribed);
            }
        }
    }

    pub fn preview_subscribe(
        env: Env,
        bond_id: u64,
        amount: i128,
    ) -> Result<PreviewSubscription, BondError> {
        investor.require_auth();

        let config: BondConfig = env
            .storage()
            .instance()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;

        let mut state: BondState = env
            .storage()
            .instance()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;

        if state.status != BondStatus::Active {
            return Err(BondError::BondAlreadyMatured);
        }

        if env.ledger().timestamp() >= config.maturity_date {
            return Err(BondError::BondAlreadyMatured);
        }

        if amount <= 0 {
            return Err(BondError::ZeroAmount);
        }

        let remaining_supply = config.total_supply - state.total_subscribed;
        if amount > remaining_supply {
            return Err(BondError::InsufficientSupply);
        }

        Ok(PreviewSubscription {
            remaining_supply,
            requested_amount: amount,
            expected_failure: None,
        })
    }
}
