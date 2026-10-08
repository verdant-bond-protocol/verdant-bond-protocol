#![no_std]
#![allow(deprecated)]
use nbbs_shared::{BondConfig, BondError, BondStatus, CreditType, RedemptionCoverage};
use soroban_sdk::{BytesN, Vec, contract, contractimpl, contracttype, vec, Address, Env, IntoVal, Symbol};

pub const MAX_SUPPLY: i128 = 1_000_000_000_000_000_000;
mod redemption_queue;
mod subscription_auction;
pub use subscription_auction::{AuctionConfig, AuctionOrder, AuctionState};
pub use redemption_queue::{RedemptionBudget, RedemptionRequest};

/// Issue #188: versioned-interface convention. Bump on a breaking storage
/// layout or interface change; see docs/upgrade-migrations.md.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    CommittedRanges(BytesN<32>, u64),
    Admin,
    BondConfig(u64),
    BondState(u64),
    HolderBalance(u64, Address),
    BalanceVersion(u64),
    HolderCheckpointCount(u64, Address),
    HolderCheckpoint(u64, Address, u32),
    SupplyCheckpointCount(u64),
    SupplyCheckpoint(u64, u32),
    RedemptionPool(u64),
    BondCount,
    Nonce(Address),
    ProjectRegistry,
    RedemptionBudget(u64),
    RedemptionCycle(u64),
    RedemptionHead(u64),
    RedemptionTail(u64),
    RedemptionRequest(u64, u64),
    RedemptionId(u64, Address, BytesN<32>),
    RedemptionReserved(u64, Address),
    TransferBlocked(Address),
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct SerialRange {
    pub start: i128,
    pub end: i128,
}

#[derive(Clone, Debug)]
#[contracttype]
pub struct BondState {
    pub total_subscribed: i128,
    pub status: BondStatus,
    pub created_at: u64,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PreviewSubscription {
    pub remaining_supply: i128,
    pub requested_amount: i128,
    pub expected_failure: Option<u32>,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct BalanceCheckpoint {
    pub version: u64,
    pub balance: i128,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct SupplyCheckpoint {
    pub version: u64,
    pub total_subscribed: i128,
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

fn advance_balance_version(env: &Env, bond_id: u64) -> Result<u64, BondError> {
    let current: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::BalanceVersion(bond_id))
        .unwrap_or(0);
    let next = current.checked_add(1).ok_or(BondError::Overflow)?;
    env.storage()
        .persistent()
        .set(&DataKey::BalanceVersion(bond_id), &next);
    Ok(next)
}

fn append_holder_checkpoint(
    env: &Env,
    bond_id: u64,
    holder: &Address,
    version: u64,
    previous_balance: i128,
    balance: i128,
) -> Result<(), BondError> {
    let count_key = DataKey::HolderCheckpointCount(bond_id, holder.clone());
    let mut index: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
    if index == 0 {
        env.storage().persistent().set(
            &DataKey::HolderCheckpoint(bond_id, holder.clone(), 0),
            &BalanceCheckpoint {
                version: 0,
                balance: previous_balance,
            },
        );
        index = 1;
    }
    env.storage().persistent().set(
        &DataKey::HolderCheckpoint(bond_id, holder.clone(), index),
        &BalanceCheckpoint { version, balance },
    );
    env.storage().persistent().set(
        &count_key,
        &index.checked_add(1).ok_or(BondError::Overflow)?,
    );
    Ok(())
}

fn append_supply_checkpoint(
    env: &Env,
    bond_id: u64,
    version: u64,
    previous_total_subscribed: i128,
    total_subscribed: i128,
) -> Result<(), BondError> {
    let count_key = DataKey::SupplyCheckpointCount(bond_id);
    let mut index: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
    if index == 0 {
        env.storage().persistent().set(
            &DataKey::SupplyCheckpoint(bond_id, 0),
            &SupplyCheckpoint {
                version: 0,
                total_subscribed: previous_total_subscribed,
            },
        );
        index = 1;
    }
    env.storage().persistent().set(
        &DataKey::SupplyCheckpoint(bond_id, index),
        &SupplyCheckpoint {
            version,
            total_subscribed,
        },
    );
    env.storage().persistent().set(
        &count_key,
        &index.checked_add(1).ok_or(BondError::Overflow)?,
    );
    Ok(())
}

fn holder_balance_at_version(
    env: &Env,
    bond_id: u64,
    holder: &Address,
    version: u64,
) -> Result<i128, BondError> {
    let count: u32 = env
        .storage()
        .persistent()
        .get(&DataKey::HolderCheckpointCount(bond_id, holder.clone()))
        .unwrap_or(0);
    if count == 0 {
        return Ok(env
            .storage()
            .persistent()
            .get(&DataKey::HolderBalance(bond_id, holder.clone()))
            .unwrap_or(0));
    }
    let mut low = 0u32;
    let mut high = count;
    while low < high {
        let middle = low + (high - low) / 2;
        let checkpoint: BalanceCheckpoint = env
            .storage()
            .persistent()
            .get(&DataKey::HolderCheckpoint(bond_id, holder.clone(), middle))
            .ok_or(BondError::BondNotFound)?;
        if checkpoint.version <= version {
            low = middle.checked_add(1).ok_or(BondError::Overflow)?;
        } else {
            high = middle;
        }
    }
    if low == 0 {
        return Ok(0);
    }
    env.storage()
        .persistent()
        .get::<_, BalanceCheckpoint>(&DataKey::HolderCheckpoint(bond_id, holder.clone(), low - 1))
        .map(|checkpoint| checkpoint.balance)
        .ok_or(BondError::BondNotFound)
}

fn total_subscribed_at_version(env: &Env, bond_id: u64, version: u64) -> Result<i128, BondError> {
    let count: u32 = env
        .storage()
        .persistent()
        .get(&DataKey::SupplyCheckpointCount(bond_id))
        .unwrap_or(0);
    if count == 0 {
        let state: BondState = env
            .storage()
            .instance()
            .get(&DataKey::BondState(bond_id))
            .ok_or(BondError::BondNotFound)?;
        return Ok(state.total_subscribed);
    }
    let mut low = 0u32;
    let mut high = count;
    while low < high {
        let middle = low + (high - low) / 2;
        let checkpoint: SupplyCheckpoint = env
            .storage()
            .persistent()
            .get(&DataKey::SupplyCheckpoint(bond_id, middle))
            .ok_or(BondError::BondNotFound)?;
        if checkpoint.version <= version {
            low = middle.checked_add(1).ok_or(BondError::Overflow)?;
        } else {
            high = middle;
        }
    }
    if low == 0 {
        return Ok(0);
    }
    env.storage()
        .persistent()
        .get::<_, SupplyCheckpoint>(&DataKey::SupplyCheckpoint(bond_id, low - 1))
        .map(|checkpoint| checkpoint.total_subscribed)
        .ok_or(BondError::BondNotFound)
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
        nonce: u64,
    ) -> Result<(), BondError> {
        current_admin.require_auth();
        consume_nonce(&env, &current_admin, nonce)?;
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

    /// Issue #188: versioned-interface convention — bump when the contract's
    /// storage layout or callable interface changes in a breaking way. See
    /// docs/upgrade-migrations.md.
    pub fn schema_version(env: Env) -> u32 {
        let _ = env;
        SCHEMA_VERSION
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
                let range_key = DataKey::CommittedRanges(config.project_id.clone(), config.credit_vintage);
        let mut ranges: Vec<SerialRange> = env.storage().persistent().get(&range_key).unwrap_or(vec![&env]);
        
        let new_start = config.serial_number_start;
        let new_end = config.serial_number_end;
        
        if new_start > new_end {
            return Err(BondError::InvalidSupply);
        }
        
        for i in 0..ranges.len() {
            let r = ranges.get(i).unwrap();
            let max_start = if new_start > r.start { new_start } else { r.start };
            let min_end = if new_end < r.end { new_end } else { r.end };
            if max_start <= min_end {
                return Err(BondError::InvalidSupply);
            }
        }
        
        ranges.push_back(SerialRange { start: new_start, end: new_end });
        env.storage().persistent().set(&range_key, &ranges);

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
        env.storage()
            .persistent()
            .set(&DataKey::BalanceVersion(bond_id), &0u64);
        env.storage().persistent().set(
            &DataKey::SupplyCheckpoint(bond_id, 0),
            &SupplyCheckpoint {
                version: 0,
                total_subscribed: 0,
            },
        );
        env.storage()
            .persistent()
            .set(&DataKey::SupplyCheckpointCount(bond_id), &1u32);

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
        if subscription_auction::configured(&env, bond_id) {
            return Err(BondError::AuctionRequired);
        }
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

        let previous_total = state.total_subscribed;
        state.total_subscribed = new_total;
        env.storage()
            .instance()
            .set(&DataKey::BondState(bond_id), &state);
        let version = advance_balance_version(&env, bond_id)?;
        append_holder_checkpoint(
            &env,
            bond_id,
            &investor,
            version,
            current_balance,
            new_balance,
        )?;
        append_supply_checkpoint(&env, bond_id, version, previous_total, new_total)?;

        env.events().publish(
            (Symbol::new(&env, "subscribed"),),
            (bond_id, investor, amount),
        );

        Ok(())
    }

    /// Read-only preflight shared by the atomic DEX settlement and transfer.
    pub fn check_transfer(
        env: Env,
        from: Address,
        to: Address,
        bond_id: u64,
        amount: i128,
    ) -> Result<(), BondError> {
        validate_transfer(&env, &from, &to, bond_id, amount)
    }

    /// Issuer compliance authority can block either trade participant.
    pub fn set_transfer_blocked(
        env: Env,
        caller: Address,
        holder: Address,
        blocked: bool,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();
        require_admin(&env, &caller)?;
        consume_nonce(&env, &caller, nonce)?;
        env.storage()
            .instance()
            .set(&DataKey::TransferBlocked(holder.clone()), &blocked);
        env.events().publish(
            (Symbol::new(&env, "transfer_compliance"),),
            (holder, blocked),
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

        validate_transfer(&env, &from, &to, bond_id, amount)?;
        let from_key = DataKey::HolderBalance(bond_id, from.clone());
        let from_balance: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);

        let new_from_balance = from_balance
            .checked_sub(amount)
            .ok_or(BondError::Overflow)?;
        env.storage().persistent().set(&from_key, &new_from_balance);

        let to_key = DataKey::HolderBalance(bond_id, to.clone());
        let to_balance: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
        let new_to_balance = to_balance.checked_add(amount).ok_or(BondError::Overflow)?;
        env.storage().persistent().set(&to_key, &new_to_balance);
        let version = advance_balance_version(&env, bond_id)?;
        append_holder_checkpoint(
            &env,
            bond_id,
            &from,
            version,
            from_balance,
            new_from_balance,
        )?;
        append_holder_checkpoint(&env, bond_id, &to, version, to_balance, new_to_balance)?;

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

    /// Compatibility path: succeeds synchronously only when the FIFO is idle
    /// and both liquidity and this cycle's budget cover the complete request.
    pub fn redeem(
        env: Env,
        holder: Address,
        bond_id: u64,
        amount: i128,
        nonce: u64,
    ) -> Result<(), BondError> {
        holder.require_auth();
        if nonce != Self::get_nonce(env.clone(), holder.clone()) {
            return Err(BondError::InvalidNonce);
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
        if state.status != BondStatus::Matured {
            return Err(BondError::BondAlreadyMatured);
        }
        if amount <= 0 {
            return Err(BondError::ZeroAmount);
        }
        let balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::HolderBalance(bond_id, holder.clone()))
            .unwrap_or(0);
        if amount > balance {
            return Err(BondError::InsufficientSupply);
        }
        let head = redemption_queue::cursor(&env, &DataKey::RedemptionHead(bond_id));
        let tail = redemption_queue::cursor(&env, &DataKey::RedemptionTail(bond_id));
        if head != 0 && head <= tail {
            return Err(BondError::RedemptionQueueRequired);
        }
        let payout = amount
            .checked_mul(config.face_value)
            .ok_or(BondError::Overflow)?;
        let pool: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::RedemptionPool(bond_id))
            .unwrap_or(0);
        if pool < payout {
            return Err(BondError::RedemptionUnderfunded);
        }
        let budget = redemption_queue::budget(&env, bond_id);
        let cycle = redemption_queue::cycle(&env, bond_id, &budget);
        if payout > budget.principal_per_cycle - cycle.paid {
            return Err(BondError::RedemptionQueueRequired);
        }
        let request_key = env
            .crypto()
            .sha256(&soroban_sdk::Bytes::from_array(&env, &nonce.to_be_bytes()))
            .into();
        let id = redemption_queue::enqueue(&env, holder, bond_id, amount, request_key, nonce)?;
        if id <= tail {
            return Err(BondError::DuplicateRedemptionRequest);
        }
        if redemption_queue::process(&env, bond_id, 1)? != 1 {
            return Err(BondError::RedemptionQueueRequired);
        }
        Ok(())
    }

    pub fn configure_redemption_budget(
        env: Env,
        caller: Address,
        bond_id: u64,
        principal_per_cycle: i128,
        ledgers_per_cycle: u32,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();
        require_admin(&env, &caller)?;
        let config: BondConfig = env
            .storage()
            .instance()
            .get(&DataKey::BondConfig(bond_id))
            .ok_or(BondError::BondNotFound)?;
        if principal_per_cycle < config.face_value || ledgers_per_cycle == 0 {
            return Err(BondError::InvalidRedemptionBudget);
        }
        if redemption_queue::cursor(&env, &DataKey::RedemptionTail(bond_id)) != 0 {
            return Err(BondError::InvalidRedemptionBudget);
        }
        consume_nonce(&env, &caller, nonce)?;
        let key = DataKey::RedemptionBudget(bond_id);
        let budget = RedemptionBudget {
            principal_per_cycle,
            ledgers_per_cycle,
        };
        env.storage().instance().set(&key, &budget);
        env.events()
            .publish((Symbol::new(&env, "redemption_budget"),), (bond_id, budget));
        Ok(())
    }

    pub fn request_redemption(
        env: Env,
        holder: Address,
        bond_id: u64,
        amount: i128,
        request_key: BytesN<32>,
        nonce: u64,
    ) -> Result<u64, BondError> {
        holder.require_auth();
        redemption_queue::enqueue(&env, holder, bond_id, amount, request_key, nonce)
    }

    /// Permissionless and bounded; callers cannot select or skip a holder.
    pub fn process_redemptions(env: Env, bond_id: u64, limit: u32) -> Result<u32, BondError> {
        redemption_queue::process(&env, bond_id, limit)
    }

    pub fn get_redemption_request(
        env: Env,
        bond_id: u64,
        id: u64,
    ) -> Result<RedemptionRequest, BondError> {
        let key = DataKey::RedemptionRequest(bond_id, id);
        let request = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(BondError::RedemptionQueueRequired)?;
        redemption_queue::touch(&env, &key);
        Ok(request)
    }

    pub fn get_redemption_budget(env: Env, bond_id: u64) -> RedemptionBudget {
        redemption_queue::budget(&env, bond_id)
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

    pub fn get_balance_version(env: Env, bond_id: u64) -> Result<u64, BondError> {
        if !env.storage().instance().has(&DataKey::BondState(bond_id)) {
            return Err(BondError::BondNotFound);
        }
        Ok(env
            .storage()
            .persistent()
            .get(&DataKey::BalanceVersion(bond_id))
            .unwrap_or(0))
    }

    pub fn get_holder_balance_at_version(
        env: Env,
        bond_id: u64,
        holder: Address,
        version: u64,
    ) -> Result<i128, BondError> {
        let current_version = Self::get_balance_version(env.clone(), bond_id)?;
        if version > current_version {
            return Err(BondError::InvalidBalanceSnapshot);
        }
        holder_balance_at_version(&env, bond_id, &holder, version)
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

    pub fn total_subscribed_at_version(
        env: Env,
        bond_id: u64,
        version: u64,
    ) -> Result<i128, BondError> {
        let current_version = Self::get_balance_version(env.clone(), bond_id)?;
        if version > current_version {
            return Err(BondError::InvalidBalanceSnapshot);
        }
        total_subscribed_at_version(&env, bond_id, version)
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
    /// Dry run of `subscribe` for `amount` units of `bond_id`.
    ///
    /// Read-only: no authorization is required and no nonce is consumed. Walks
    /// the same checks as `subscribe`, in the same order, and reports the
    /// first one that would fail as `expected_failure` instead of returning an
    /// error, so callers can size an order before paying for a transaction.
    /// Only an unknown bond is an error, since there is nothing to preview.
    /// The per-holder balance overflow check in `subscribe` is not modelled
    /// because the preview has no investor.
    /// Dry run of `subscribe` for `amount` units of `bond_id`.
    ///
    /// Read-only: no authorization is required and no nonce is consumed. Walks
    /// the same checks as `subscribe`, in the same order, and reports the
    /// first one that would fail as `expected_failure` instead of returning an
    /// error, so callers can size an order before paying for a transaction.
    /// Only an unknown bond is an error, since there is nothing to preview.
    /// The per-holder balance overflow check in `subscribe` is not modelled
    /// because the preview has no investor.
    pub fn preview_subscribe(
        env: Env,
        bond_id: u64,
        amount: i128,
    ) -> Result<PreviewSubscription, BondError> {
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

        let expected_failure = if subscription_auction::configured(&env, bond_id) {
            Some(BondError::AuctionRequired as u32)
        } else if amount <= 0 {
            Some(BondError::ZeroAmount as u32)
        } else if state.status != BondStatus::Active
            || env.ledger().timestamp() >= config.maturity_date
        {
            Some(BondError::BondAlreadyMatured as u32)
        } else {
            match state.total_subscribed.checked_add(amount) {
                None => Some(BondError::Overflow as u32),
                Some(new_total) if new_total > config.total_supply => {
                    Some(BondError::InsufficientSupply as u32)
                }
                Some(_) => None,
            }
        };

        Ok(PreviewSubscription {
            remaining_supply: config.total_supply - state.total_subscribed,
            requested_amount: amount,
            expected_failure,
        })
    }
}



fn validate_transfer(
    env: &Env,
    from: &Address,
    to: &Address,
    bond_id: u64,
    amount: i128,
) -> Result<(), BondError> {
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

    let to_balance: i128 = env
        .storage()
        .persistent()
        .get(&DataKey::HolderBalance(bond_id, to.clone()))
        .unwrap_or(0);
    to_balance.checked_add(amount).ok_or(BondError::Overflow)?;
    for party in [from, to] {
        if env
            .storage()
            .instance()
            .get::<_, bool>(&DataKey::TransferBlocked(party.clone()))
            .unwrap_or(false)
        {
            return Err(BondError::Unauthorized);
        }
    }
    Ok(())
}

fn settle_redemption(
    env: &Env,
    holder: Address,
    bond_id: u64,
    amount: i128,
) -> Result<(), BondError> {
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

    let previous_total = state.total_subscribed;
    state.total_subscribed = state
        .total_subscribed
        .checked_sub(amount)
        .ok_or(BondError::Overflow)?;
    env.storage()
        .instance()
        .set(&DataKey::BondState(bond_id), &state);
    let version = advance_balance_version(&env, bond_id)?;
    append_holder_checkpoint(
        &env,
        bond_id,
        &holder,
        version,
        current_balance,
        new_balance,
    )?;
    append_supply_checkpoint(
        &env,
        bond_id,
        version,
        previous_total,
        state.total_subscribed,
    )?;

    env.events().publish(
        (Symbol::new(&env, "redeemed"),),
        (bond_id, holder, amount, payout),
    );

    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;
    mod redemption_queue_test { include!("redemption_queue_test.rs"); }
    mod transfer_preflight_test { include!("transfer_preflight_test.rs"); }
    mod subscription_auction_test { include!("subscription_auction_test.rs"); }
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
            total_supply: 10_000,
            credit_vintage: 2024,
            serial_number_start: 1,
            serial_number_end: 10_000,
            
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
    fn test_issue_bond_overlap_detection() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let id = env.register(BondIssuer, (admin.clone(),));
        let client = BondIssuerClient::new(&env, &id);

        let config1 = BondConfig {
            project_id: create_project_id(&env, 1),
            face_value: 1000,
            coupon_schedule: vec![&env, 1000u64],
            credit_type: CreditType::Carbon,
            maturity_date: 2000,
            total_supply: 10_000,
            credit_vintage: 2024,
            serial_number_start: 100,
            serial_number_end: 200,
        };
        assert_eq!(client.issue_bond(&admin, &config1, &0), 1);

        // Near-miss (adjacent) - before
        let config2 = BondConfig {
            project_id: create_project_id(&env, 1),
            face_value: 1000,
            coupon_schedule: vec![&env, 1000u64],
            credit_type: CreditType::Carbon,
            maturity_date: 2000,
            total_supply: 10_000,
            credit_vintage: 2024,
            serial_number_start: 50,
            serial_number_end: 99,
        };
        assert_eq!(client.issue_bond(&admin, &config2, &1), 2);

        // Near-miss (adjacent) - after
        let config3 = BondConfig {
            project_id: create_project_id(&env, 1),
            face_value: 1000,
            coupon_schedule: vec![&env, 1000u64],
            credit_type: CreditType::Carbon,
            maturity_date: 2000,
            total_supply: 10_000,
            credit_vintage: 2024,
            serial_number_start: 201,
            serial_number_end: 300,
        };
        assert_eq!(client.issue_bond(&admin, &config3, &2), 3);

        // Exact overlap
        let mut config_overlap = config1.clone();
        config_overlap.serial_number_start = 150;
        config_overlap.serial_number_end = 250;
        assert_eq!(client.try_issue_bond(&admin, &config_overlap, &3), Err(Ok(BondError::InvalidSupply)));

        // Subset
        let mut config_subset = config1.clone();
        config_subset.serial_number_start = 120;
        config_subset.serial_number_end = 180;
        assert_eq!(client.try_issue_bond(&admin, &config_subset, &3), Err(Ok(BondError::InvalidSupply)));
        
        // Overlap boundary - start
        let mut config_b1 = config1.clone();
        config_b1.serial_number_start = 90;
        config_b1.serial_number_end = 100;
        assert_eq!(client.try_issue_bond(&admin, &config_b1, &3), Err(Ok(BondError::InvalidSupply)));

        // Overlap boundary - end
        let mut config_b2 = config1.clone();
        config_b2.serial_number_start = 200;
        config_b2.serial_number_end = 210;
        assert_eq!(client.try_issue_bond(&admin, &config_b2, &3), Err(Ok(BondError::InvalidSupply)));
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

        assert_eq!(
            client.try_set_admin(&admin, &new_admin, &1),
            Err(Ok(BondError::InvalidNonce))
        );
        client.set_admin(&admin, &new_admin, &0);
        assert_eq!(client.get_admin(), new_admin);

        assert_eq!(
            client.try_issue_bond(&admin, &config, &1),
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
    fn test_balance_checkpoints_preserve_settlement_snapshot() {
        let (env, client, admin, holder) = setup();
        let recipient = Address::generate(&env);
        let bond_id = client.issue_bond(&admin, &make_config(&env), &0);
        client.subscribe(&holder, &bond_id, &1_000, &0);
        let settlement_version = client.get_balance_version(&bond_id);

        client.transfer(&holder, &recipient, &bond_id, &400, &1);
        let later_subscriber = Address::generate(&env);
        client.subscribe(&later_subscriber, &bond_id, &500, &0);
        assert_eq!(
            client.get_holder_balance_at_version(&bond_id, &holder, &settlement_version),
            1_000
        );
        assert_eq!(
            client.get_holder_balance_at_version(&bond_id, &recipient, &settlement_version),
            0
        );
        assert_eq!(
            client.total_subscribed_at_version(&bond_id, &settlement_version),
            1_000
        );
        assert_eq!(client.total_subscribed(&bond_id), 1_500);
        assert_eq!(client.get_holder_balance(&bond_id, &holder), 600);
        assert_eq!(client.get_holder_balance(&bond_id, &recipient), 400);
        assert_eq!(
            client.try_get_holder_balance_at_version(&bond_id, &holder, &4),
            Err(Ok(BondError::InvalidBalanceSnapshot))
        );
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

                let mut config2 = config.clone();
        config2.serial_number_start = 10001;
        config2.serial_number_end = 20000;
        client.issue_bond(&admin, &config2, &1);
        assert_eq!(client.bond_count(), 2);
    }

    #[test]
    fn test_preview_subscribe_clean_order() {
        let (env, client, admin, _user) = setup();
        let bond_id = client.issue_bond(&admin, &make_config(&env), &0);

        let preview = client.preview_subscribe(&bond_id, &100);
        assert_eq!(preview.remaining_supply, 10000);
        assert_eq!(preview.requested_amount, 100);
        assert_eq!(preview.expected_failure, None);
    }

    #[test]
    fn test_preview_subscribe_reports_each_failure() {
        let (env, client, admin, user) = setup();
        let config = make_config(&env);
        let bond_id = client.issue_bond(&admin, &config, &0);

        assert_eq!(
            client.preview_subscribe(&bond_id, &0).expected_failure,
            Some(BondError::ZeroAmount as u32)
        );
        assert_eq!(
            client.preview_subscribe(&bond_id, &10001).expected_failure,
            Some(BondError::InsufficientSupply as u32)
        );

        client.subscribe(&user, &bond_id, &4000, &0);
        let preview = client.preview_subscribe(&bond_id, &6001);
        assert_eq!(preview.remaining_supply, 6000);
        assert_eq!(
            preview.expected_failure,
            Some(BondError::InsufficientSupply as u32)
        );
        assert_eq!(
            client.preview_subscribe(&bond_id, &6000).expected_failure,
            None
        );

        assert_eq!(
            client
                .preview_subscribe(&bond_id, &i128::MAX)
                .expected_failure,
            Some(BondError::Overflow as u32)
        );

        env.ledger().set_timestamp(config.maturity_date);
        assert_eq!(
            client.preview_subscribe(&bond_id, &1).expected_failure,
            Some(BondError::BondAlreadyMatured as u32)
        );

        assert_eq!(
            client.try_preview_subscribe(&99, &1),
            Err(Ok(BondError::BondNotFound))
        );
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
            // The preview is only useful if it never lies: for any amount, the
            // failure it predicts is exactly what subscribe then returns, and a
            // clean preview is always followed by a successful subscription.
            #[test]
            fn preview_subscribe_agrees_with_subscribe(
                supply in 1i128..100_000i128,
                amounts in proptest::collection::vec(-100i128..60_000i128, 1..20),
            ) {
                let env = Env::default();
                env.mock_all_auths();
                let admin = Address::generate(&env);
                let user = Address::generate(&env);
                let contract_id = env.register(BondIssuer, (&admin,));
                let client = BondIssuerClient::new(&env, &contract_id);

                let mut config = make_config(&env);
                config.total_supply = supply;
                let bond_id = client.issue_bond(&admin, &config, &0);

                let mut nonce = 0u64;
                let mut total_subscribed = 0i128;
                for amount in amounts {
                    let preview = client.preview_subscribe(&bond_id, &amount);
                    prop_assert_eq!(preview.remaining_supply, supply - total_subscribed);
                    prop_assert_eq!(preview.requested_amount, amount);

                    let actual = match client.try_subscribe(&user, &bond_id, &amount, &nonce) {
                        Ok(_) => {
                            nonce += 1;
                            total_subscribed += amount;
                            None
                        }
                        Err(Ok(e)) => Some(e as u32),
                        Err(Err(e)) => return Err(TestCaseError::fail(std::format!("{e:?}"))),
                    };
                    prop_assert_eq!(preview.expected_failure, actual);
                }
            }

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

}
