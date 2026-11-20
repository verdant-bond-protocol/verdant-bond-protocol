use super::*;

/// Principal minor units per 720-ledger cycle (~1 hour at five-second ledgers).
pub const DEFAULT_REDEMPTION_BUDGET: i128 = 1_000_000_000;
pub const DEFAULT_REDEMPTION_CYCLE: u32 = 720;
pub const MAX_REDEMPTION_BATCH: u32 = 50;

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct RedemptionBudget {
    pub principal_per_cycle: i128,
    pub ledgers_per_cycle: u32,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct RedemptionRequest {
    pub id: u64,
    pub holder: Address,
    pub request_key: BytesN<32>,
    pub submitted_ledger: u32,
    pub amount: i128,
    pub remaining: i128,
}

#[derive(Clone)]
#[contracttype]
pub struct RedemptionCycle {
    pub cycle: u32,
    pub paid: i128,
}

pub(crate) fn touch(env: &Env, key: &DataKey) {
    let ttl = env.storage().max_ttl();
    env.storage().persistent().extend_ttl(key, ttl / 2, ttl);
}

pub(crate) fn budget(env: &Env, bond_id: u64) -> RedemptionBudget {
    let key = DataKey::RedemptionBudget(bond_id);
    let value = env
        .storage()
        .instance()
        .get(&key)
        .unwrap_or(RedemptionBudget {
            principal_per_cycle: DEFAULT_REDEMPTION_BUDGET,
            ledgers_per_cycle: DEFAULT_REDEMPTION_CYCLE,
        });
    value
}

pub(crate) fn cycle(env: &Env, bond_id: u64, config: &RedemptionBudget) -> RedemptionCycle {
    let current = env.ledger().sequence() / config.ledgers_per_cycle;
    let key = DataKey::RedemptionCycle(bond_id);
    let value: RedemptionCycle = env
        .storage()
        .instance()
        .get(&key)
        .unwrap_or(RedemptionCycle {
            cycle: current,
            paid: 0,
        });
    if value.cycle == current {
        value
    } else {
        RedemptionCycle {
            cycle: current,
            paid: 0,
        }
    }
}

pub(crate) fn reserved(env: &Env, bond_id: u64, holder: &Address) -> i128 {
    let key = DataKey::RedemptionReserved(bond_id, holder.clone());
    let value = env.storage().instance().get(&key).unwrap_or(0);
    value
}

pub(crate) fn cursor(env: &Env, key: &DataKey) -> u64 {
    let value = env.storage().instance().get(key).unwrap_or(0);
    value
}

pub(crate) fn enqueue(
    env: &Env,
    holder: Address,
    bond_id: u64,
    amount: i128,
    request_key: BytesN<32>,
    nonce: u64,
) -> Result<u64, BondError> {
    let replay_key = DataKey::RedemptionId(bond_id, holder.clone(), request_key.clone());
    if let Some((id, queued_amount)) = env.storage().instance().get::<_, (u64, i128)>(&replay_key) {
        if queued_amount != amount {
            return Err(BondError::DuplicateRedemptionRequest);
        }
        return Ok(id);
    }
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
    let current_reserved = reserved(env, bond_id, &holder);
    if amount
        > balance
            .checked_sub(current_reserved)
            .ok_or(BondError::Overflow)?
    {
        return Err(BondError::InsufficientSupply);
    }
    consume_nonce(env, &holder, nonce)?;
    let tail_key = DataKey::RedemptionTail(bond_id);
    let id = cursor(env, &tail_key)
        .checked_add(1)
        .ok_or(BondError::Overflow)?;
    let request = RedemptionRequest {
        id,
        holder: holder.clone(),
        request_key,
        submitted_ledger: env.ledger().sequence(),
        amount,
        remaining: amount,
    };
    let key = DataKey::RedemptionRequest(bond_id, id);
    env.storage().persistent().set(&key, &request);
    touch(env, &key);
    env.storage().instance().set(&replay_key, &(id, amount));
    env.storage().instance().set(&tail_key, &id);
    let head_key = DataKey::RedemptionHead(bond_id);
    if cursor(env, &head_key) == 0 {
        env.storage().instance().set(&head_key, &1u64);
    }
    let reserved_key = DataKey::RedemptionReserved(bond_id, holder.clone());
    env.storage().instance().set(
        &reserved_key,
        &current_reserved
            .checked_add(amount)
            .ok_or(BondError::Overflow)?,
    );

    // Freeze the default config too: governance cannot reset cycles after enqueue.
    let config_key = DataKey::RedemptionBudget(bond_id);
    env.storage()
        .instance()
        .set(&config_key, &budget(env, bond_id));
    env.events().publish(
        (Symbol::new(env, "redemption_queued"),),
        (bond_id, id, holder, amount, request.submitted_ledger),
    );
    Ok(id)
}

pub(crate) fn process(env: &Env, bond_id: u64, limit: u32) -> Result<u32, BondError> {
    let config: BondConfig = env
        .storage()
        .instance()
        .get(&DataKey::BondConfig(bond_id))
        .ok_or(BondError::BondNotFound)?;
    if config.face_value <= 0 {
        return Err(BondError::InvalidRedemptionBudget);
    }
    let config_budget = budget(env, bond_id);
    let mut usage = cycle(env, bond_id, &config_budget);
    let head_key = DataKey::RedemptionHead(bond_id);
    let tail = cursor(env, &DataKey::RedemptionTail(bond_id));
    let mut head = cursor(env, &head_key);
    let mut completed = 0;
    for _ in 0..limit.min(MAX_REDEMPTION_BATCH) {
        if head == 0 || head > tail {
            break;
        }
        let pool_key = DataKey::RedemptionPool(bond_id);
        let pool: i128 = env.storage().persistent().get(&pool_key).unwrap_or(0);
        let available = pool.min(
            config_budget
                .principal_per_cycle
                .checked_sub(usage.paid)
                .ok_or(BondError::Overflow)?,
        );
        let key = DataKey::RedemptionRequest(bond_id, head);
        let mut request: RedemptionRequest = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(BondError::RedemptionQueueRequired)?;
        touch(env, &key);
        let amount = request.remaining.min(available / config.face_value);
        if amount <= 0 {
            break;
        }
        let payout = amount
            .checked_mul(config.face_value)
            .ok_or(BondError::Overflow)?;
        // Same issuer burn/checkpoint path as synchronous redemption, no holder
        // signature needed again: the authenticated queued request reserved it.
        settle_redemption(env, request.holder.clone(), bond_id, amount)?;
        usage.paid = usage.paid.checked_add(payout).ok_or(BondError::Overflow)?;
        request.remaining -= amount;
        let reserved_key = DataKey::RedemptionReserved(bond_id, request.holder.clone());
        let next_reserved = reserved(env, bond_id, &request.holder)
            .checked_sub(amount)
            .ok_or(BondError::Overflow)?;
        env.storage().instance().set(&reserved_key, &next_reserved);
        env.storage().persistent().set(&key, &request);
        touch(env, &key);
        env.events().publish(
            (Symbol::new(env, "redemption_processed"),),
            (bond_id, head, amount, payout, request.remaining),
        );
        if request.remaining != 0 {
            break;
        }
        head = head.checked_add(1).ok_or(BondError::Overflow)?;
        completed += 1;
    }
    env.storage().instance().set(&head_key, &head);
    let usage_key = DataKey::RedemptionCycle(bond_id);
    env.storage().instance().set(&usage_key, &usage);
    Ok(completed)
}
