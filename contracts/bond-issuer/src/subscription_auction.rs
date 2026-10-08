use super::*;
use soroban_sdk::token;

/// Bound atomic settlement work. Admission is fixed before the open ledger.
pub const MAX_AUCTION_WALLETS: u32 = 32;

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct AuctionConfig {
    pub token: Address,
    pub treasury: Address,
    pub open_ledger: u32,
    pub cutoff_ledger: u32,
    pub identity_cap: i128,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct AuctionOrder {
    pub wallet: Address,
    pub identity: BytesN<32>,
    pub requested: i128,
    pub allocated: i128,
    pub refunded: i128,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct AuctionState {
    pub config: AuctionConfig,
    pub wallets: Vec<Address>,
    pub orders: Vec<AuctionOrder>,
    pub settled: bool,
}

#[derive(Clone)]
#[contracttype]
// Variant prefixes distinguish these serialized storage keys from DataKey.
#[allow(clippy::enum_variant_names)]
enum AuctionKey {
    SubscriptionAuctionRequired(u64),
    SubscriptionAuction(u64),
    SubscriptionIdentity(u64, Address),
}

pub fn configured(env: &Env, bond_id: u64) -> bool {
    env.storage()
        .instance()
        .has(&AuctionKey::SubscriptionAuctionRequired(bond_id))
}

fn load(env: &Env, bond_id: u64) -> Result<AuctionState, BondError> {
    env.storage()
        .persistent()
        .get(&AuctionKey::SubscriptionAuction(bond_id))
        .ok_or(BondError::InvalidAuction)
}

/// Hamilton apportionment: input is already in canonical tie-break order.
/// Return exact integer allocations whose sum is min(capacity, demand).
pub(crate) fn apportion(
    env: &Env,
    requests: &Vec<i128>,
    capacity: i128,
) -> Result<Vec<i128>, BondError> {
    if capacity < 0 || requests.len() > MAX_AUCTION_WALLETS {
        return Err(BondError::InvalidAuction);
    }
    let mut total = 0i128;
    for request in requests.iter() {
        if !(0..=MAX_SUPPLY).contains(&request) {
            return Err(BondError::InvalidAuction);
        }
        total = total.checked_add(request).ok_or(BondError::Overflow)?;
    }
    if total <= capacity {
        return Ok(requests.clone());
    }
    let mut allocations = Vec::new(env);
    let mut remainders = Vec::new(env);
    let mut allocated = 0i128;
    for request in requests.iter() {
        let product = request.checked_mul(capacity).ok_or(BondError::Overflow)?;
        let amount = product / total;
        allocated = allocated.checked_add(amount).ok_or(BondError::Overflow)?;
        allocations.push_back(amount);
        remainders.push_back(product % total);
    }
    for _ in 0..(capacity - allocated) as u32 {
        let mut best = 0;
        for index in 1..remainders.len() {
            if remainders.get(index).unwrap() > remainders.get(best).unwrap() {
                best = index;
            }
        }
        allocations.set(best, allocations.get(best).unwrap() + 1);
        remainders.set(best, -1);
    }
    Ok(allocations)
}

#[contractimpl]
impl BondIssuer {
    /// Create the tranche and reserve its primary issuance for this auction in
    /// one invocation, so nobody can race the subscription-open transaction.
    pub fn issue_auction(
        env: Env,
        caller: Address,
        config: BondConfig,
        auction: AuctionConfig,
        nonce: u64,
    ) -> Result<u64, BondError> {
        if auction.open_ledger <= env.ledger().sequence()
            || auction.cutoff_ledger <= auction.open_ledger
            || auction.identity_cap <= 0
            || auction.identity_cap > MAX_SUPPLY
            || auction.treasury == env.current_contract_address()
            || config.total_supply.checked_mul(config.face_value).is_none()
        {
            return Err(BondError::InvalidAuction);
        }
        let bond_id = Self::issue_bond(env.clone(), caller, config, nonce)?;
        // Shares the bond configuration's instance lifetime. An archived order
        // book must fail closed rather than reopen legacy subscriptions.
        env.storage()
            .instance()
            .set(&AuctionKey::SubscriptionAuctionRequired(bond_id), &true);
        env.storage().persistent().set(
            &AuctionKey::SubscriptionAuction(bond_id),
            &AuctionState {
                config: auction,
                wallets: Vec::new(&env),
                orders: Vec::new(&env),
                settled: false,
            },
        );
        Ok(bond_id)
    }

    /// The issuer's entitlement authority binds preverified KYC commitments,
    /// never caller-provided identities. Admission is sealed before opening.
    pub fn grant_subscription(
        env: Env,
        caller: Address,
        bond_id: u64,
        wallet: Address,
        identity: BytesN<32>,
        nonce: u64,
    ) -> Result<(), BondError> {
        caller.require_auth();
        require_admin(&env, &caller)?;
        consume_nonce(&env, &caller, nonce)?;
        let mut auction = load(&env, bond_id)?;
        if env.ledger().sequence() >= auction.config.open_ledger {
            return Err(BondError::AuctionClosed);
        }
        let key = AuctionKey::SubscriptionIdentity(bond_id, wallet.clone());
        if env.storage().persistent().has(&key)
            || auction.wallets.len() >= MAX_AUCTION_WALLETS
            || identity == BytesN::from_array(&env, &[0; 32])
            || wallet == env.current_contract_address()
        {
            return Err(BondError::InvalidAuction);
        }
        env.storage().persistent().set(&key, &identity);
        auction.wallets.push_back(wallet.clone());
        env.storage()
            .persistent()
            .set(&AuctionKey::SubscriptionAuction(bond_id), &auction);
        env.events().publish(
            (Symbol::new(&env, "subscription_entitled"), bond_id),
            (wallet, identity),
        );
        Ok(())
    }

    pub fn commit_subscription(
        env: Env,
        investor: Address,
        bond_id: u64,
        amount: i128,
        nonce: u64,
    ) -> Result<(), BondError> {
        investor.require_auth();
        consume_nonce(&env, &investor, nonce)?;
        let mut auction = load(&env, bond_id)?;
        let ledger = env.ledger().sequence();
        if auction.settled
            || ledger < auction.config.open_ledger
            || ledger >= auction.config.cutoff_ledger
        {
            return Err(BondError::AuctionClosed);
        }
        let config = Self::get_bond(env.clone(), bond_id)?;
        if env.ledger().timestamp() >= config.maturity_date
            || Self::get_bond_state(env.clone(), bond_id)?.status != BondStatus::Active
        {
            return Err(BondError::BondAlreadyMatured);
        }
        if amount <= 0 || amount > MAX_SUPPLY {
            return Err(BondError::ZeroAmount);
        }
        let identity: BytesN<32> = env
            .storage()
            .persistent()
            .get(&AuctionKey::SubscriptionIdentity(bond_id, investor.clone()))
            .ok_or(BondError::SubscriptionIneligible)?;
        let mut identity_total = amount;
        for order in auction.orders.iter() {
            if order.identity == identity {
                identity_total = identity_total
                    .checked_add(order.requested)
                    .ok_or(BondError::Overflow)?;
            }
        }
        if identity_total > auction.config.identity_cap {
            return Err(BondError::IdentityCapExceeded);
        }
        let capital = amount
            .checked_mul(config.face_value)
            .ok_or(BondError::Overflow)?;
        let mut found = false;
        for index in 0..auction.orders.len() {
            let mut order = auction.orders.get(index).unwrap();
            if order.wallet == investor {
                order.requested = order
                    .requested
                    .checked_add(amount)
                    .ok_or(BondError::Overflow)?;
                auction.orders.set(index, order);
                found = true;
                break;
            }
        }
        if !found {
            auction.orders.push_back(AuctionOrder {
                wallet: investor.clone(),
                identity,
                requested: amount,
                allocated: 0,
                refunded: 0,
            });
        }
        env.storage()
            .persistent()
            .set(&AuctionKey::SubscriptionAuction(bond_id), &auction);
        token::Client::new(&env, &auction.config.token).transfer(
            &investor,
            env.current_contract_address(),
            &capital,
        );
        env.events().publish(
            (Symbol::new(&env, "subscription_committed"), bond_id),
            (investor, amount),
        );
        Ok(())
    }

    /// Permissionless, bounded, atomic allocation and refund after cutoff.
    /// A matured tranche cancels instead, refunding every committed token.
    pub fn settle_subscription(env: Env, bond_id: u64) -> Result<AuctionState, BondError> {
        let mut auction = load(&env, bond_id)?;
        if auction.settled || env.ledger().sequence() < auction.config.cutoff_ledger {
            return Err(BondError::AuctionClosed);
        }
        let config = Self::get_bond(env.clone(), bond_id)?;
        let mut state = Self::get_bond_state(env.clone(), bond_id)?;
        // Canonical order: identity commitment, then wallet address.
        for i in 1..auction.orders.len() {
            let mut j = i;
            while j > 0 {
                let left = auction.orders.get(j - 1).unwrap();
                let right = auction.orders.get(j).unwrap();
                if (left.identity.clone(), left.wallet.clone())
                    <= (right.identity.clone(), right.wallet.clone())
                {
                    break;
                }
                auction.orders.set(j - 1, right);
                auction.orders.set(j, left);
                j -= 1;
            }
        }
        let mut identities: Vec<BytesN<32>> = Vec::new(&env);
        let mut demands: Vec<i128> = Vec::new(&env);
        for order in auction.orders.iter() {
            if identities.last() == Some(order.identity.clone()) {
                let i = demands.len() - 1;
                demands.set(
                    i,
                    demands
                        .get(i)
                        .unwrap()
                        .checked_add(order.requested)
                        .ok_or(BondError::Overflow)?,
                );
            } else {
                identities.push_back(order.identity);
                demands.push_back(order.requested);
            }
        }
        let capacity = if state.status == BondStatus::Active
            && env.ledger().timestamp() < config.maturity_date
        {
            config.total_supply - state.total_subscribed
        } else {
            0
        };
        let identity_allocations = apportion(&env, &demands, capacity)?;
        for i in 0..identities.len() {
            let identity = identities.get(i).unwrap();
            let mut requests = Vec::new(&env);
            let mut indexes = Vec::new(&env);
            for j in 0..auction.orders.len() {
                let order = auction.orders.get(j).unwrap();
                if order.identity == identity {
                    requests.push_back(order.requested);
                    indexes.push_back(j);
                }
            }
            let amounts = apportion(&env, &requests, identity_allocations.get(i).unwrap())?;
            for j in 0..indexes.len() {
                let index = indexes.get(j).unwrap();
                let mut order = auction.orders.get(index).unwrap();
                order.allocated = amounts.get(j).unwrap();
                order.refunded = (order.requested - order.allocated)
                    .checked_mul(config.face_value)
                    .ok_or(BondError::Overflow)?;
                auction.orders.set(index, order);
            }
        }
        auction.settled = true;
        env.storage()
            .persistent()
            .set(&AuctionKey::SubscriptionAuction(bond_id), &auction);
        let previous_total = state.total_subscribed;
        let version = advance_balance_version(&env, bond_id)?;
        let token = token::Client::new(&env, &auction.config.token);
        for order in auction.orders.iter() {
            if order.allocated > 0 {
                let key = DataKey::HolderBalance(bond_id, order.wallet.clone());
                let previous: i128 = env.storage().persistent().get(&key).unwrap_or(0);
                let balance = previous
                    .checked_add(order.allocated)
                    .ok_or(BondError::Overflow)?;
                env.storage().persistent().set(&key, &balance);
                append_holder_checkpoint(&env, bond_id, &order.wallet, version, previous, balance)?;
                state.total_subscribed = state
                    .total_subscribed
                    .checked_add(order.allocated)
                    .ok_or(BondError::Overflow)?;
            }
            if order.refunded > 0 {
                token.transfer(
                    &env.current_contract_address(),
                    &order.wallet,
                    &order.refunded,
                );
            }
        }
        let proceeds = (state.total_subscribed - previous_total)
            .checked_mul(config.face_value)
            .ok_or(BondError::Overflow)?;
        if proceeds > 0 {
            token.transfer(
                &env.current_contract_address(),
                &auction.config.treasury,
                &proceeds,
            );
        }
        env.storage()
            .instance()
            .set(&DataKey::BondState(bond_id), &state);
        append_supply_checkpoint(
            &env,
            bond_id,
            version,
            previous_total,
            state.total_subscribed,
        )?;
        env.events().publish(
            (Symbol::new(&env, "subscription_settled"), bond_id),
            auction.orders.clone(),
        );
        Ok(auction)
    }

    pub fn get_subscription(env: Env, bond_id: u64) -> Result<AuctionState, BondError> {
        load(&env, bond_id)
    }
}
