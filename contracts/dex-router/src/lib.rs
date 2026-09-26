#![no_std]
#![allow(deprecated)]
use nbbs_shared::DEXError;
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, Env, IntoVal, Symbol, Vec};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Order(u64),
    OrderCount,
    SellerOrders(Address),
    BondOrders(u64),
    BondIssuerAddress,
    CouponEngineAddress,
    Balance(Symbol, Address),
    BondEscrow(u64, Address),
    Nonce(Address),
    /// Rolling time-and-price observations per bond, feeding `get_twap`.
    PriceObs(u64, Symbol),
}

/// A single executed-trade price observation used to derive a time-weighted
/// average price (TWAP). Recorded on every fill in `execute_purchase`.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PriceObservation {
    /// Ledger timestamp at which the trade executed.
    pub timestamp: u64,
    /// Executed price per token (the filled order's `price_per_token`).
    pub price: i128,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Order {
    pub id: u64,
    pub seller: Address,
    pub bond_id: u64,
    pub amount: i128,
    pub price_per_token: i128,
    pub quote_asset: Symbol,
    pub status: OrderStatus,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum OrderStatus {
    Open,
    PartiallyFilled,
    Filled,
    Cancelled,
    Expired,
}

/// Result of a bounded expired-order cleanup pass.
///
/// `next_start_id` is the order id to pass as `start_id` on the next call.
/// It is `0` when the scan has reached `OrderCount` (cleanup complete for now).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct CleanExpiredResult {
    pub cleaned: u32,
    pub next_start_id: u64,
}

/// Hard cap on orders scanned per `clean_expired_orders` invocation so a single
/// call cannot exhaust the ledger resource budget even if the caller passes a
/// large `limit`.
const MAX_CLEAN_BATCH: u32 = 100;

/// Maximum number of price observations retained per bond. Bounds the storage
/// and the `get_twap` scan so a single call cannot exhaust the resource budget.
const MAX_PRICE_OBS: u32 = 32;

fn require_admin(env: &Env, caller: &Address) -> Result<(), DEXError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(DEXError::NotInitialized)?;
    if caller != &admin {
        return Err(DEXError::Unauthorized);
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

fn get_balance(env: &Env, addr: &Address, asset: &Symbol) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(asset.clone(), addr.clone()))
        .unwrap_or(0)
}

fn set_balance(env: &Env, addr: &Address, asset: &Symbol, amount: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::Balance(asset.clone(), addr.clone()), &amount);
}

fn get_bond_escrow(env: &Env, bond_id: u64, addr: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::BondEscrow(bond_id, addr.clone()))
        .unwrap_or(0)
}

fn set_bond_escrow(env: &Env, bond_id: u64, addr: &Address, amount: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::BondEscrow(bond_id, addr.clone()), &amount);
}

fn is_order_expired(env: &Env, order: &Order) -> bool {
    env.ledger().timestamp() >= order.expires_at
}

fn get_price_obs(env: &Env, bond_id: u64, quote_asset: &Symbol) -> Vec<PriceObservation> {
    env.storage()
        .instance()
        .get(&DataKey::PriceObs(bond_id, quote_asset.clone()))
        .unwrap_or_else(|| vec![env])
}

/// Append an executed-trade observation for `bond_id`, keeping only the most
/// recent [`MAX_PRICE_OBS`] entries (FIFO). Best-effort: never fails a fill.
fn record_price_observation(env: &Env, bond_id: u64, quote_asset: &Symbol, price: i128) {
    let mut obs = get_price_obs(env, bond_id, quote_asset);
    let timestamp = env.ledger().timestamp();

    // Multiple fills in one ledger timestamp have no time between them. Keep
    // only the latest price for that timestamp so a burst of same-timestamp
    // fills cannot evict older observations that provide the time coverage.
    if let Some(last) = obs.pop_back() {
        if last.timestamp == timestamp {
            obs.push_back(PriceObservation { timestamp, price });
        } else {
            obs.push_back(last);
            obs.push_back(PriceObservation { timestamp, price });
        }
    } else {
        obs.push_back(PriceObservation { timestamp, price });
    }
    while obs.len() > MAX_PRICE_OBS {
        obs.pop_front();
    }
    env.storage()
        .instance()
        .set(&DataKey::PriceObs(bond_id, quote_asset.clone()), &obs);
}

/// Compute the time-weighted average price (TWAP) for `bond_id` over the trailing
/// `window_seconds`.
///
/// Each observation's price prevails from its own timestamp until the next
/// observation (the latest prevails until `now`); only the portion of each
/// interval that falls inside the window is counted, so a single-transaction
/// price spike contributes weight proportional to the (tiny) time it persisted,
/// not to its magnitude. This is the flash-loan-resistant price any financial
/// consumer must use instead of the last trade / spot price (see
/// docs/security/flash-loan-price-manipulation.md).
fn compute_twap(
    env: &Env,
    bond_id: u64,
    quote_asset: &Symbol,
    window_seconds: u64,
) -> Result<i128, DEXError> {
    if window_seconds == 0 {
        return Err(DEXError::ZeroAmount);
    }
    let obs = get_price_obs(env, bond_id, quote_asset);
    let n = obs.len();
    if n == 0 {
        return Err(DEXError::NoPriceData);
    }

    let now = env.ledger().timestamp();
    let cutoff = now.saturating_sub(window_seconds);

    let mut weighted_sum: i128 = 0;
    let mut total_weight: i128 = 0;

    for i in 0..n {
        let cur = obs.get(i).unwrap();
        // This price prevails until the next observation, or `now` for the last.
        let seg_end = if i + 1 < n {
            obs.get(i + 1).unwrap().timestamp
        } else {
            now
        }
        .min(now);
        // Clamp the segment start into the window: an observation older than the
        // window still carries its price forward from `cutoff`.
        let seg_start = cur.timestamp.max(cutoff);
        if seg_end <= seg_start {
            continue;
        }
        let weight = (seg_end - seg_start) as i128;
        let contribution = cur.price.checked_mul(weight).ok_or(DEXError::Overflow)?;
        weighted_sum = weighted_sum
            .checked_add(contribution)
            .ok_or(DEXError::Overflow)?;
        total_weight += weight;
    }

    // Do not fall back to the latest spot price when there is no elapsed
    // history. That would let a same-timestamp burst bypass TWAP protection.
    if total_weight == 0 {
        return Err(DEXError::NoPriceData);
    }

    Ok(weighted_sum / total_weight)
}

/// Persist `Expired` on an open/partial order that has passed its deadline.
/// Used by the batched `clean_expired_orders` sweep.
fn mark_order_expired(env: &Env, order_id: u64, mut order: Order) -> Order {
    order.status = OrderStatus::Expired;
    env.storage()
        .instance()
        .set(&DataKey::Order(order_id), &order);
    order
}

fn verify_holder_balance(
    env: &Env,
    holder: &Address,
    bond_id: u64,
    required: i128,
) -> Result<(), DEXError> {
    let bond_issuer: Address = env
        .storage()
        .instance()
        .get(&DataKey::BondIssuerAddress)
        .ok_or(DEXError::NotInitialized)?;

    let balance: i128 = env.invoke_contract(
        &bond_issuer,
        &Symbol::new(env, "get_holder_balance"),
        vec![&env, bond_id.into_val(env), holder.clone().into_val(env)],
    );

    if balance < required {
        return Err(DEXError::InsufficientBalance);
    }
    Ok(())
}

#[contract]
pub struct DEXRouter;

#[allow(clippy::too_many_arguments)]
#[contractimpl]
impl DEXRouter {
    pub fn __constructor(
        env: Env,
        admin: Address,
        bond_issuer_address: Address,
        coupon_engine_address: Address,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::BondIssuerAddress, &bond_issuer_address);
        env.storage()
            .instance()
            .set(&DataKey::CouponEngineAddress, &coupon_engine_address);
    }

    pub fn set_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), DEXError> {
        current_admin.require_auth();
        require_admin(&env, &current_admin)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (Symbol::new(&env, "admin_changed"),),
            (current_admin, new_admin),
        );
        Ok(())
    }

    pub fn get_admin(env: Env) -> Result<Address, DEXError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(DEXError::NotInitialized)
    }

    pub fn get_nonce(env: Env, address: Address) -> u64 {
        get_nonce(&env, &address)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn list_bond_tokens(
        env: Env,
        seller: Address,
        bond_id: u64,
        amount: i128,
        price_per_token: i128,
        quote_asset: Symbol,
        expires_after_seconds: u64,
        nonce: u64,
    ) -> Result<u64, DEXError> {
        seller.require_auth();

        let expected_nonce = get_nonce(&env, &seller);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &seller, expected_nonce + 1);

        if amount <= 0 || price_per_token <= 0 {
            return Err(DEXError::ZeroAmount);
        }
        if expires_after_seconds == 0 {
            return Err(DEXError::OrderExpired);
        }

        verify_holder_balance(&env, &seller, bond_id, amount)?;

        // Escrow the bond tokens at listing time (prevents seller from transferring them away)
        let current_escrow = get_bond_escrow(&env, bond_id, &seller);
        let new_escrow = current_escrow
            .checked_add(amount)
            .ok_or(DEXError::Overflow)?;
        set_bond_escrow(&env, bond_id, &seller, new_escrow);

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::OrderCount)
            .unwrap_or(0);
        let order_id = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::OrderCount, &order_id);

        let now = env.ledger().timestamp();
        let expires_at = now
            .checked_add(expires_after_seconds)
            .ok_or(DEXError::OrderExpired)?;
        let order = Order {
            id: order_id,
            seller: seller.clone(),
            bond_id,
            amount,
            price_per_token,
            quote_asset,
            status: OrderStatus::Open,
            created_at: now,
            expires_at,
        };

        env.storage()
            .instance()
            .set(&DataKey::Order(order_id), &order);

        let mut seller_orders: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::SellerOrders(seller.clone()))
            .unwrap_or(vec![&env]);
        seller_orders.push_back(order_id);
        env.storage()
            .instance()
            .set(&DataKey::SellerOrders(seller.clone()), &seller_orders);

        let mut bond_orders: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::BondOrders(bond_id))
            .unwrap_or(vec![&env]);
        bond_orders.push_back(order_id);
        env.storage()
            .instance()
            .set(&DataKey::BondOrders(bond_id), &bond_orders);

        env.events().publish(
            (Symbol::new(&env, "order_listed"),),
            (order_id, seller, bond_id, amount, price_per_token),
        );

        Ok(order_id)
    }

    pub fn cancel_listing(
        env: Env,
        caller: Address,
        order_id: u64,
        nonce: u64,
    ) -> Result<(), DEXError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        let mut order: Order = env
            .storage()
            .instance()
            .get(&DataKey::Order(order_id))
            .ok_or(DEXError::OrderNotFound)?;

        if caller != order.seller {
            return Err(DEXError::Unauthorized);
        }

        if order.status != OrderStatus::Open && order.status != OrderStatus::PartiallyFilled {
            return Err(DEXError::OrderAlreadyFilled);
        }

        // Release escrowed tokens when order is cancelled
        let seller_escrow = get_bond_escrow(&env, order.bond_id, &order.seller);
        let new_escrow = seller_escrow.checked_sub(order.amount).unwrap_or(0);
        set_bond_escrow(&env, order.bond_id, &order.seller, new_escrow);

        order.status = OrderStatus::Cancelled;
        env.storage()
            .instance()
            .set(&DataKey::Order(order_id), &order);

        env.events()
            .publish((Symbol::new(&env, "order_cancelled"),), (order_id, caller));

        Ok(())
    }

    pub fn execute_purchase(
        env: Env,
        buyer: Address,
        order_id: u64,
        max_price: i128,
        amount: i128,
        nonce: u64,
    ) -> Result<(), DEXError> {
        buyer.require_auth();

        let expected_nonce = get_nonce(&env, &buyer);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &buyer, expected_nonce + 1);

        let mut order: Order = env
            .storage()
            .instance()
            .get(&DataKey::Order(order_id))
            .ok_or(DEXError::OrderNotFound)?;

        if order.status != OrderStatus::Open && order.status != OrderStatus::PartiallyFilled {
            return Err(DEXError::OrderAlreadyFilled);
        }

        if buyer == order.seller {
            return Err(DEXError::SelfBuyNotAllowed);
        }

        // Note: we deliberately do NOT persist `Expired` here. A Soroban call
        // that returns an error reverts all writes, so any hot-path marking on
        // this error path could never take effect — see the tradeoff note on
        // `clean_expired_orders`.
        if is_order_expired(&env, &order) {
            return Err(DEXError::OrderExpired);
        }

        if amount <= 0 {
            return Err(DEXError::ZeroAmount);
        }

        if amount > order.amount {
            return Err(DEXError::InsufficientBalance);
        }

        if max_price < order.price_per_token {
            return Err(DEXError::InsufficientBalance);
        }

        // Verify seller has escrowed bond tokens before attempting transfer
        let seller_escrow = get_bond_escrow(&env, order.bond_id, &order.seller);
        if seller_escrow < amount {
            return Err(DEXError::InsufficientBalance);
        }

        let proceeds = amount
            .checked_mul(order.price_per_token)
            .ok_or(DEXError::Overflow)?;

        let buyer_balance = get_balance(&env, &buyer, &order.quote_asset);
        if buyer_balance < proceeds {
            return Err(DEXError::InsufficientFunds);
        }
        set_balance(&env, &buyer, &order.quote_asset, buyer_balance - proceeds);

        let seller_balance = get_balance(&env, &order.seller, &order.quote_asset);
        let new_seller_balance = seller_balance
            .checked_add(proceeds)
            .ok_or(DEXError::Overflow)?;
        set_balance(&env, &order.seller, &order.quote_asset, new_seller_balance);

        let bond_issuer: Address = env
            .storage()
            .instance()
            .get(&DataKey::BondIssuerAddress)
            .ok_or(DEXError::NotInitialized)?;
        let seller_bond_nonce: u64 = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "get_nonce"),
            vec![&env, order.seller.clone().into_val(&env)],
        );

        env.invoke_contract::<()>(
            &bond_issuer,
            &Symbol::new(&env, "transfer"),
            vec![
                &env,
                order.seller.clone().into_val(&env),
                buyer.clone().into_val(&env),
                order.bond_id.into_val(&env),
                amount.into_val(&env),
                seller_bond_nonce.into_val(&env),
            ],
        );

        // Release escrowed tokens on successful fill
        let new_seller_escrow = seller_escrow - amount;
        set_bond_escrow(&env, order.bond_id, &order.seller, new_seller_escrow);

        if amount == order.amount {
            order.status = OrderStatus::Filled;
        } else {
            order.status = OrderStatus::PartiallyFilled;
            order.amount -= amount;
        }

        env.storage()
            .instance()
            .set(&DataKey::Order(order_id), &order);

        // Record the executed price for TWAP. Any downstream financial use of a
        // bond's market price must read `get_twap`, never the last/spot price, so
        // a single-transaction distortion cannot move a valuation (#216).
        record_price_observation(
            &env,
            order.bond_id,
            &order.quote_asset,
            order.price_per_token,
        );

        env.events().publish(
            (Symbol::new(&env, "order_filled"),),
            (
                order_id,
                buyer,
                order.seller.clone(),
                amount,
                order.price_per_token,
                proceeds,
            ),
        );

        Ok(())
    }

    pub fn deposit_quote(
        env: Env,
        caller: Address,
        quote_asset: Symbol,
        amount: i128,
        nonce: u64,
    ) -> Result<(), DEXError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        if amount <= 0 {
            return Err(DEXError::ZeroAmount);
        }

        let balance = get_balance(&env, &caller, &quote_asset);
        let new_balance = balance.checked_add(amount).ok_or(DEXError::Overflow)?;
        set_balance(&env, &caller, &quote_asset, new_balance);

        env.events().publish(
            (Symbol::new(&env, "quote_deposited"),),
            (caller, quote_asset, amount),
        );

        Ok(())
    }

    pub fn withdraw_quote(
        env: Env,
        caller: Address,
        quote_asset: Symbol,
        amount: i128,
        nonce: u64,
    ) -> Result<(), DEXError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        if amount <= 0 {
            return Err(DEXError::ZeroAmount);
        }

        let balance = get_balance(&env, &caller, &quote_asset);
        if balance < amount {
            return Err(DEXError::InsufficientFunds);
        }
        set_balance(&env, &caller, &quote_asset, balance - amount);

        env.events().publish(
            (Symbol::new(&env, "quote_withdrawn"),),
            (caller, quote_asset, amount),
        );

        Ok(())
    }

    pub fn get_quote_balance(env: Env, address: Address, quote_asset: Symbol) -> i128 {
        get_balance(&env, &address, &quote_asset)
    }

    pub fn get_seller_bond_escrow(env: Env, seller: Address, bond_id: u64) -> i128 {
        get_bond_escrow(&env, bond_id, &seller)
    }

    pub fn get_order(env: Env, order_id: u64) -> Result<Order, DEXError> {
        env.storage()
            .instance()
            .get(&DataKey::Order(order_id))
            .ok_or(DEXError::OrderNotFound)
    }

    /// Time-weighted average executed price for `bond_id` and `quote_asset`
    /// over the trailing `window_seconds`.
    ///
    /// This is the manipulation-resistant price that any function with financial
    /// consequences (collateral valuation, redemption pricing, …) must consume
    /// instead of the most recent trade price: a large single-transaction price
    /// distortion contributes weight proportional only to the brief time it
    /// persisted, so it cannot meaningfully move the average (see
    /// docs/security/flash-loan-price-manipulation.md). Returns `NoPriceData`
    /// when the bond has never traded.
    pub fn get_twap(
        env: Env,
        bond_id: u64,
        quote_asset: Symbol,
        window_seconds: u64,
    ) -> Result<i128, DEXError> {
        compute_twap(&env, bond_id, &quote_asset, window_seconds)
    }

    /// Raw price observations retained for `bond_id` and `quote_asset` (most
    /// recent last), for off-chain analysis / monitoring.
    pub fn get_price_observations(
        env: Env,
        bond_id: u64,
        quote_asset: Symbol,
    ) -> Vec<PriceObservation> {
        get_price_obs(&env, bond_id, &quote_asset)
    }

    pub fn get_bond_orders(env: Env, bond_id: u64) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&DataKey::BondOrders(bond_id))
            .unwrap_or(vec![&env])
    }

    pub fn get_seller_orders(env: Env, seller: Address) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&DataKey::SellerOrders(seller))
            .unwrap_or(vec![&env])
    }

    pub fn order_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::OrderCount)
            .unwrap_or(0)
    }

    /// Mark expired open/partial orders in a bounded ID window.
    ///
    /// # Batching
    /// Scans at most `min(limit, MAX_CLEAN_BATCH)` order IDs starting at
    /// `start_id` (treat `0` as `1`). Returns how many were marked expired and
    /// the next `start_id` to continue with (`0` when the pass has reached
    /// `OrderCount`). Callers should loop until `next_start_id == 0`.
    ///
    /// # Tradeoff: batched sweep vs lazy/opportunistic cleanup
    /// Lazy alternatives were considered and rejected: marking an order
    /// `Expired` inside `execute_purchase`'s error path cannot work because a
    /// Soroban call that returns an error reverts all writes, and scanning a
    /// seller's full order list inside `list_bond_tokens` would reintroduce
    /// unbounded work on a user-facing path. A periodic, cursor-batched admin
    /// sweep covers cold expired orders under a fixed per-call resource
    /// budget. Shared batch helpers across contracts were skipped: storage
    /// layouts differ enough that a thin local loop is clearer.
    pub fn clean_expired_orders(
        env: Env,
        caller: Address,
        start_id: u64,
        limit: u32,
        nonce: u64,
    ) -> Result<CleanExpiredResult, DEXError> {
        caller.require_auth();

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(DEXError::InvalidNonce);
        }
        set_nonce(&env, &caller, expected_nonce + 1);

        require_admin(&env, &caller)?;

        if limit == 0 {
            return Err(DEXError::ZeroAmount);
        }

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::OrderCount)
            .unwrap_or(0);

        let start = if start_id == 0 { 1 } else { start_id };
        if count == 0 || start > count {
            let result = CleanExpiredResult {
                cleaned: 0,
                next_start_id: 0,
            };
            env.events().publish(
                (Symbol::new(&env, "expired_orders_cleaned"),),
                (result.cleaned, result.next_start_id),
            );
            return Ok(result);
        }

        let batch = if limit > MAX_CLEAN_BATCH {
            MAX_CLEAN_BATCH
        } else {
            limit
        };
        let end = start
            .saturating_add(batch as u64)
            .saturating_sub(1)
            .min(count);

        let mut cleaned: u32 = 0;
        for id in start..=end {
            let key = DataKey::Order(id);
            if let Some(order) = env.storage().instance().get::<DataKey, Order>(&key) {
                if (order.status == OrderStatus::Open
                    || order.status == OrderStatus::PartiallyFilled)
                    && is_order_expired(&env, &order)
                {
                    mark_order_expired(&env, id, order);
                    cleaned += 1;
                }
            }
        }

        let next_start_id = if end >= count { 0 } else { end + 1 };
        let result = CleanExpiredResult {
            cleaned,
            next_start_id,
        };

        env.events().publish(
            (Symbol::new(&env, "expired_orders_cleaned"),),
            (result.cleaned, result.next_start_id),
        );

        Ok(result)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        vec, BytesN, Env, Symbol,
    };

    fn create_project_id(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[31] = value;
        BytesN::from_array(env, &arr)
    }

    fn setup_bond_and_holder(
        env: &Env,
        bond_supply: i128,
        holder_subscribe: i128,
    ) -> (Address, Address, u64, Address) {
        let issuer_admin = Address::generate(env);
        let issuer_id = env.register(nbbs_bond_issuer::BondIssuer, (issuer_admin.clone(),));
        let issuer_client = nbbs_bond_issuer::BondIssuerClient::new(env, &issuer_id);

        let project_id = create_project_id(env, 1);
        let bond_config = nbbs_shared::BondConfig {
            project_id,
            face_value: 1000,
            coupon_schedule: vec![env, 1_000_000u64, 2_000_000u64],
            credit_type: nbbs_shared::CreditType::Carbon,
            maturity_date: 3_000_000,
            total_supply: bond_supply,
        };

        let bond_id = issuer_client.issue_bond(&issuer_admin, &bond_config, &0);

        let holder = Address::generate(env);
        issuer_client.subscribe(&holder, &bond_id, &holder_subscribe, &0);

        (issuer_admin, issuer_id, bond_id, holder)
    }

    #[test]
    fn test_list_tokens() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id.clone(), Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );
        assert_eq!(order_id, 1);

        let order = client.get_order(&order_id);
        assert_eq!(order.seller, seller);
        assert_eq!(order.bond_id, bond_id);
        assert_eq!(order.amount, 1_000);
        assert_eq!(order.price_per_token, 100);
        assert_eq!(order.status, OrderStatus::Open);

        let bond_orders = client.get_bond_orders(&bond_id);
        assert_eq!(bond_orders.len(), 1);
        assert_eq!(bond_orders.get(0).unwrap(), order_id);

        let seller_orders = client.get_seller_orders(&seller);
        assert_eq!(seller_orders.len(), 1);
        assert_eq!(seller_orders.get(0).unwrap(), order_id);

        assert_eq!(client.order_count(), 1);
    }

    #[test]
    fn test_buy_full_order() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id.clone(), Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &100_000i128, &0);

        client.execute_purchase(&buyer, &order_id, &100i128, &1_000i128, &1);

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::Filled);

        let issuer_client = nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &seller), 4_000);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &buyer), 1_000);

        assert_eq!(
            client.get_quote_balance(&buyer, &Symbol::new(&env, "USDC")),
            0
        );
        assert_eq!(
            client.get_quote_balance(&seller, &Symbol::new(&env, "USDC")),
            100_000
        );
    }

    #[test]
    fn test_buy_partial_fill() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id.clone(), Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &100_000i128, &0);

        client.execute_purchase(&buyer, &order_id, &100i128, &400i128, &1);

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::PartiallyFilled);
        assert_eq!(order.amount, 600);

        let issuer_client = nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &seller), 4_600);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &buyer), 400);

        assert_eq!(
            client.get_quote_balance(&buyer, &Symbol::new(&env, "USDC")),
            60_000
        );
        assert_eq!(
            client.get_quote_balance(&seller, &Symbol::new(&env, "USDC")),
            40_000
        );

        client.execute_purchase(&buyer, &order_id, &100i128, &600i128, &2);

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::Filled);

        assert_eq!(issuer_client.get_holder_balance(&bond_id, &seller), 4_000);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &buyer), 1_000);

        assert_eq!(
            client.get_quote_balance(&buyer, &Symbol::new(&env, "USDC")),
            0
        );
        assert_eq!(
            client.get_quote_balance(&seller, &Symbol::new(&env, "USDC")),
            100_000
        );
    }

    #[test]
    fn test_buy_fails_when_seller_balance_depleted() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let third_party = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 1_000);

        let issuer_client = nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id.clone());

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        issuer_client.transfer(&seller, &third_party, &bond_id, &1_000, &1);

        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &100_000i128, &0);

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &1_000i128, &1);
        assert!(result.is_err());

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::Open);
        assert_eq!(order.amount, 1_000);

        assert_eq!(issuer_client.get_holder_balance(&bond_id, &buyer), 0);
        assert_eq!(
            client.get_quote_balance(&buyer, &Symbol::new(&env, "USDC")),
            100_000
        );
        assert_eq!(
            client.get_quote_balance(&seller, &Symbol::new(&env, "USDC")),
            0
        );
    }

    #[test]
    fn test_seller_escrow_prevents_balance_depletion() {
        // Test that seller cannot bypass escrow by transferring tokens directly via BondIssuer
        // The escrow lock at listing time protects against this attack
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let third_party = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 1_000);

        let issuer_client = nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id.clone());

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        // Seller lists 1000 tokens - these are now escrowed
        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        // Verify escrow is locked
        assert_eq!(client.get_seller_bond_escrow(&seller, &bond_id), 1_000);

        // Seller tries to transfer escrowed tokens away via BondIssuer (bypassing DEX)
        issuer_client.transfer(&seller, &third_party, &bond_id, &1_000, &1);

        // Seller now has 0 actual balance, but escrow still shows 1000
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &seller), 0);
        assert_eq!(client.get_seller_bond_escrow(&seller, &bond_id), 1_000);

        // Buyer deposits and attempts to fill - should fail because escrow check happens BEFORE transfer
        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &100_000i128, &0);

        // The purchase should fail with InsufficientBalance (escrow check catches it)
        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &1_000i128, &1);
        assert_eq!(result, Err(Ok(DEXError::InsufficientBalance)));

        // Verify state is unchanged - buyer was not debited
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &buyer), 0);
        assert_eq!(
            client.get_quote_balance(&buyer, &Symbol::new(&env, "USDC")),
            100_000
        );
        assert_eq!(
            client.get_quote_balance(&seller, &Symbol::new(&env, "USDC")),
            0
        );

        // Order remains open and unchanged
        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::Open);
        assert_eq!(order.amount, 1_000);
    }

    #[test]
    fn test_buy_failed_purchase_does_not_debit_buyer() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let issuer_client = nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id.clone());

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        let result = client.try_execute_purchase(&buyer, &order_id, &50i128, &1_000i128, &0);
        assert_eq!(result, Err(Ok(DEXError::InsufficientBalance)));

        assert_eq!(issuer_client.get_holder_balance(&bond_id, &seller), 5_000);
        assert_eq!(issuer_client.get_holder_balance(&bond_id, &buyer), 0);
    }

    #[test]
    fn test_buy_requires_escrow_funds() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &50_000i128, &0);

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &1_000i128, &1);
        assert_eq!(result, Err(Ok(DEXError::InsufficientFunds)));

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::Open);
        assert_eq!(order.amount, 1_000);

        assert_eq!(
            client.get_quote_balance(&buyer, &Symbol::new(&env, "USDC")),
            50_000
        );
        assert_eq!(
            client.get_quote_balance(&seller, &Symbol::new(&env, "USDC")),
            0
        );
    }

    #[test]
    fn test_deposit_and_withdraw_quote() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let contract_id = env.register(
            DEXRouter,
            (
                admin.clone(),
                Address::generate(&env),
                Address::generate(&env),
            ),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        client.deposit_quote(&user, &Symbol::new(&env, "USDC"), &10_000i128, &0);
        client.deposit_quote(&user, &Symbol::new(&env, "XLM"), &5_000i128, &1);

        assert_eq!(
            client.get_quote_balance(&user, &Symbol::new(&env, "USDC")),
            10_000
        );
        assert_eq!(
            client.get_quote_balance(&user, &Symbol::new(&env, "XLM")),
            5_000
        );

        let result = client.try_withdraw_quote(&user, &Symbol::new(&env, "USDC"), &11_000i128, &2);
        assert_eq!(result, Err(Ok(DEXError::InsufficientFunds)));

        client.withdraw_quote(&user, &Symbol::new(&env, "USDC"), &4_000i128, &2);
        assert_eq!(
            client.get_quote_balance(&user, &Symbol::new(&env, "USDC")),
            6_000
        );
    }

    #[test]
    fn test_cancel_listing() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        client.cancel_listing(&seller, &order_id, &1);

        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::Cancelled);
    }

    #[test]
    fn test_cancel_unauthorized() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let stranger = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        let result = client.try_cancel_listing(&stranger, &order_id, &0);
        assert_eq!(result, Err(Ok(DEXError::Unauthorized)));
    }

    #[test]
    fn test_self_buy_reject() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        let result = client.try_execute_purchase(&seller, &order_id, &100i128, &1_000i128, &1);
        assert_eq!(result, Err(Ok(DEXError::SelfBuyNotAllowed)));
    }

    #[test]
    fn test_insufficient_balance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 1_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let result = client.try_list_bond_tokens(
            &seller,
            &bond_id,
            &2_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );
        assert_eq!(result, Err(Ok(DEXError::InsufficientBalance)));
    }

    #[test]
    fn test_expired_order() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &100u64,
            &0,
        );

        env.ledger().set_timestamp(1_000_101);

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &500i128, &0);
        assert_eq!(result, Err(Ok(DEXError::OrderExpired)));
    }

    #[test]
    fn test_nonexistent_order() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);

        let contract_id = env.register(
            DEXRouter,
            (
                admin.clone(),
                Address::generate(&env),
                Address::generate(&env),
            ),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let result = client.try_get_order(&999);
        assert_eq!(result, Err(Ok(DEXError::OrderNotFound)));
    }

    #[test]
    fn test_clean_expired_orders() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &100u64,
            &0,
        );

        client.list_bond_tokens(
            &seller,
            &bond_id,
            &500i128,
            &200i128,
            &Symbol::new(&env, "XLM"),
            &10_000u64,
            &1,
        );

        env.ledger().set_timestamp(1_000_200);

        let result = client.clean_expired_orders(&admin, &0, &100, &0);
        assert_eq!(result.cleaned, 1);
        assert_eq!(result.next_start_id, 0);

        let order1 = client.get_order(&order_id);
        assert_eq!(order1.status, OrderStatus::Expired);

        let result = client.try_execute_purchase(
            &Address::generate(&env),
            &order_id,
            &100i128,
            &100i128,
            &0,
        );
        assert_eq!(result, Err(Ok(DEXError::OrderAlreadyFilled)));
    }

    #[test]
    fn test_clean_expired_orders_batched() {
        extern crate std;

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        // Enough balance for many small listings from one seller.
        let order_count: u64 = 40;
        let per_order = 10i128;
        let (_issuer_admin, issuer_id, bond_id, seller) = setup_bond_and_holder(
            &env,
            order_count as i128 * per_order,
            order_count as i128 * per_order,
        );

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        let mut expected_expired = 0u32;

        for i in 0..order_count {
            // Alternate short-lived and long-lived so batches mix expired + live.
            let ttl = if i % 2 == 0 { 50u64 } else { 10_000u64 };
            client.list_bond_tokens(
                &seller,
                &bond_id,
                &per_order,
                &100i128,
                &Symbol::new(&env, "USDC"),
                &ttl,
                &i,
            );
            if i % 2 == 0 {
                expected_expired += 1;
            }
        }

        env.ledger().set_timestamp(1_000_100);

        let batch_size = 7u32;
        let mut start_id = 0u64;
        let mut admin_nonce = 0u64;
        let mut total_cleaned = 0u32;
        let mut passes = 0u32;

        loop {
            let result = client.clean_expired_orders(&admin, &start_id, &batch_size, &admin_nonce);
            admin_nonce += 1;
            total_cleaned += result.cleaned;
            passes += 1;

            // Each pass must scan at most batch_size IDs; cleaned cannot exceed that.
            assert!(result.cleaned <= batch_size);

            if result.next_start_id == 0 {
                break;
            }
            // Cursor must advance; no double-processing of the same window.
            assert!(result.next_start_id > start_id || start_id == 0);
            start_id = result.next_start_id;
            assert!(passes < 100, "cleanup did not terminate");
        }

        assert_eq!(total_cleaned, expected_expired);
        assert!(passes > 1, "expected multi-call batched cleanup");

        for id in 1..=order_count {
            let order = client.get_order(&id);
            // Odd ids came from even i (short TTL) → Expired; even ids stay Open.
            if id % 2 == 1 {
                assert_eq!(order.status, OrderStatus::Expired);
            } else {
                assert_eq!(order.status, OrderStatus::Open);
            }
        }

        // Re-running a completed sweep cleans nothing (idempotent / no double-process).
        let again = client.clean_expired_orders(&admin, &0, &batch_size, &admin_nonce);
        assert_eq!(again.cleaned, 0);
    }

    #[test]
    fn test_clean_expired_orders_rejects_zero_limit() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let contract_id = env.register(
            DEXRouter,
            (
                admin.clone(),
                Address::generate(&env),
                Address::generate(&env),
            ),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let result = client.try_clean_expired_orders(&admin, &1, &0, &0);
        assert_eq!(result, Err(Ok(DEXError::ZeroAmount)));
    }

    #[test]
    fn test_buy_more_than_listed() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &2_000i128, &0);
        assert_eq!(result, Err(Ok(DEXError::InsufficientBalance)));
    }

    #[test]
    fn test_buy_with_low_max_price() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        let result = client.try_execute_purchase(&buyer, &order_id, &50i128, &500i128, &0);
        assert_eq!(result, Err(Ok(DEXError::InsufficientBalance)));
    }

    #[test]
    fn test_purchase_zero_amount_rejected() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &0i128, &0);
        assert_eq!(result, Err(Ok(DEXError::ZeroAmount)));

        let order = client.get_order(&order_id);
        assert_eq!(order.amount, 1_000);
        assert_eq!(order.status, OrderStatus::Open);
    }

    #[test]
    fn test_list_zero_amount_rejected() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let result = client.try_list_bond_tokens(
            &seller,
            &bond_id,
            &0i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );
        assert_eq!(result, Err(Ok(DEXError::ZeroAmount)));
    }

    #[test]
    fn test_order_expired_at_expiry_timestamp() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        env.ledger().set_timestamp(1_000_000);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &100u64,
            &0,
        );

        env.ledger().set_timestamp(1_000_100);

        let result = client.try_execute_purchase(&buyer, &order_id, &100i128, &500i128, &0);
        assert_eq!(result, Err(Ok(DEXError::OrderExpired)));
    }

    // --- TWAP / flash-loan price-manipulation resistance (#216) ---

    #[test]
    fn test_twap_is_time_weighted_average() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 100_000, 50_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);
        let usdc = Symbol::new(&env, "USDC");

        env.ledger().set_timestamp(1000);
        let o1 = client.list_bond_tokens(
            &seller,
            &bond_id,
            &100i128,
            &100i128,
            &usdc,
            &1_000_000u64,
            &0,
        );
        let o2 = client.list_bond_tokens(
            &seller,
            &bond_id,
            &100i128,
            &300i128,
            &usdc,
            &1_000_000u64,
            &1,
        );
        client.deposit_quote(&buyer, &usdc, &10_000_000i128, &0);

        // Trade at price 100 @ t=1000, then price 300 @ t=2000.
        env.ledger().set_timestamp(1000);
        client.execute_purchase(&buyer, &o1, &100i128, &100i128, &1);
        env.ledger().set_timestamp(2000);
        client.execute_purchase(&buyer, &o2, &300i128, &100i128, &2);

        // At t=3000: price 100 prevailed [1000,2000) and price 300 [2000,3000],
        // so TWAP = (100*1000 + 300*1000) / 2000 = 200.
        env.ledger().set_timestamp(3000);
        assert_eq!(client.get_twap(&bond_id, &usdc, &5000u64), 200);
    }

    #[test]
    fn test_twap_resists_single_transaction_spike() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 100_000, 50_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);
        let usdc = Symbol::new(&env, "USDC");

        env.ledger().set_timestamp(1000);
        let o1 = client.list_bond_tokens(
            &seller,
            &bond_id,
            &100i128,
            &100i128,
            &usdc,
            &1_000_000u64,
            &0,
        );
        let o2 = client.list_bond_tokens(
            &seller,
            &bond_id,
            &100i128,
            &100i128,
            &usdc,
            &1_000_000u64,
            &1,
        );
        let o3 = client.list_bond_tokens(
            &seller,
            &bond_id,
            &100i128,
            &100i128,
            &usdc,
            &1_000_000u64,
            &2,
        );
        // The attacker's manipulated trade: 100x the honest price for one unit.
        let spike = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1i128,
            &10_000i128,
            &usdc,
            &1_000_000u64,
            &3,
        );
        client.deposit_quote(&buyer, &usdc, &100_000_000i128, &0);

        // Honest trades at price 100 across the window.
        env.ledger().set_timestamp(1000);
        client.execute_purchase(&buyer, &o1, &100i128, &100i128, &1);
        env.ledger().set_timestamp(2000);
        client.execute_purchase(&buyer, &o2, &100i128, &100i128, &2);
        env.ledger().set_timestamp(3000);
        client.execute_purchase(&buyer, &o3, &100i128, &100i128, &3);
        // Flash spike at t=3001.
        env.ledger().set_timestamp(3001);
        client.execute_purchase(&buyer, &spike, &10_000i128, &1i128, &4);

        // One second later: the spike price (10_000) persisted for only 1s out of
        // ~2000s, so TWAP stays near the honest 100 even though the last trade
        // (spot) was 10_000 — a 100x distortion the TWAP absorbs to <2x.
        env.ledger().set_timestamp(3002);
        let twap = client.get_twap(&bond_id, &usdc, &5000u64);
        assert!(
            twap < 200,
            "TWAP {twap} must stay near the honest price, not the 10_000 spike"
        );
        // Sanity: the raw last trade really was the 10_000 spike.
        assert_eq!(client.get_order(&spike).price_per_token, 10_000);
    }

    #[test]
    fn test_twap_without_trades_errors() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, _seller) =
            setup_bond_and_holder(&env, 100_000, 50_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        // A bond that has never traded has no price to report.
        let result = client.try_get_twap(&bond_id, &Symbol::new(&env, "USDC"), &1000u64);
        assert_eq!(result, Err(Ok(DEXError::NoPriceData)));
    }

    #[test]
    fn test_twap_zero_window_rejected() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 100_000, 50_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);
        let usdc = Symbol::new(&env, "USDC");

        env.ledger().set_timestamp(1000);
        let o1 = client.list_bond_tokens(
            &seller,
            &bond_id,
            &100i128,
            &100i128,
            &usdc,
            &1_000_000u64,
            &0,
        );
        client.deposit_quote(&buyer, &usdc, &1_000_000i128, &0);
        client.execute_purchase(&buyer, &o1, &100i128, &100i128, &1);

        let result = client.try_get_twap(&bond_id, &Symbol::new(&env, "USDC"), &0u64);
        assert_eq!(result, Err(Ok(DEXError::ZeroAmount)));
    }

    #[test]
    fn test_same_timestamp_fills_preserve_history_and_never_fallback_to_spot() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 100_000, 50_000);
        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);
        let usdc = Symbol::new(&env, "USDC");

        // Establish real historical coverage at the honest price.
        env.ledger().set_timestamp(1000);
        let history = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1i128,
            &100i128,
            &usdc,
            &1_000_000u64,
            &0,
        );
        client.deposit_quote(&buyer, &usdc, &1_000_000i128, &0);
        client.execute_purchase(&buyer, &history, &100i128, &1i128, &1);

        // Thirty-two same-timestamp fills must coalesce, not evict the older
        // observation and leave TWAP with only an attacker-controlled spot.
        env.ledger().set_timestamp(2000);
        for index in 1..33u64 {
            let order = client.list_bond_tokens(
                &seller,
                &bond_id,
                &1i128,
                &10_000i128,
                &usdc,
                &1_000_000u64,
                &index,
            );
            client.execute_purchase(&buyer, &order, &10_000i128, &1i128, &(index + 1));
        }

        env.ledger().set_timestamp(2001);
        let twap = client.get_twap(&bond_id, &usdc, &5_000u64);
        assert!(twap < 200, "TWAP {twap} must retain historical coverage");
        assert_ne!(twap, 10_000);
    }

    // --- Order replay / stale-state hardening (#215) ---
    //
    // Cross-network and cross-contract replay are enforced by the Soroban host's
    // native-auth preimage (network id + target contract + args), which
    // `mock_all_auths` bypasses, so they are documented in
    // docs/security/order-signing-replay-protection.md rather than exercised
    // here. These tests cover the contract-level guards: fully-filled replay,
    // partial-fill over-fill, remaining-amount accounting, and the explicit
    // per-account nonce.

    #[test]
    fn test_filled_order_cannot_be_repurchased() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );
        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &1_000_000i128, &0);

        // Fully fill the order.
        client.execute_purchase(&buyer, &order_id, &100i128, &1_000i128, &1);
        assert_eq!(client.get_order(&order_id).status, OrderStatus::Filled);

        // Replaying the (now Filled) order must be rejected, even for 1 unit.
        let replay = client.try_execute_purchase(&buyer, &order_id, &100i128, &1i128, &2);
        assert_eq!(replay, Err(Ok(DEXError::OrderAlreadyFilled)));
    }

    #[test]
    fn test_partial_order_cannot_be_overfilled() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );
        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &1_000_000i128, &0);

        // Fill 400 of 1000; remaining must be tracked on-chain as 600.
        client.execute_purchase(&buyer, &order_id, &100i128, &400i128, &1);
        let order = client.get_order(&order_id);
        assert_eq!(order.status, OrderStatus::PartiallyFilled);
        assert_eq!(order.amount, 600);

        // Attempting to buy 601 (more than the remaining 600) must be rejected.
        let overfill = client.try_execute_purchase(&buyer, &order_id, &100i128, &601i128, &2);
        assert_eq!(overfill, Err(Ok(DEXError::InsufficientBalance)));
    }

    #[test]
    fn test_partial_fills_decrement_remaining_to_filled() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );
        client.deposit_quote(&buyer, &Symbol::new(&env, "USDC"), &1_000_000i128, &0);

        client.execute_purchase(&buyer, &order_id, &100i128, &600i128, &1);
        assert_eq!(client.get_order(&order_id).amount, 400);

        client.execute_purchase(&buyer, &order_id, &100i128, &400i128, &2);
        assert_eq!(client.get_order(&order_id).status, OrderStatus::Filled);

        // No units remain to replay.
        let replay = client.try_execute_purchase(&buyer, &order_id, &100i128, &1i128, &3);
        assert_eq!(replay, Err(Ok(DEXError::OrderAlreadyFilled)));
    }

    #[test]
    fn test_stale_nonce_replay_rejected() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let (_issuer_admin, issuer_id, _bond_id, _seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        let usdc = Symbol::new(&env, "USDC");
        assert_eq!(client.get_nonce(&user), 0);
        client.deposit_quote(&user, &usdc, &100i128, &0);
        assert_eq!(client.get_nonce(&user), 1);

        // Replaying nonce 0 (already consumed) is rejected.
        let replay = client.try_deposit_quote(&user, &usdc, &100i128, &0);
        assert_eq!(replay, Err(Ok(DEXError::InvalidNonce)));

        // A skipped/future nonce is also rejected — nonces are strictly sequential.
        let skipped = client.try_deposit_quote(&user, &usdc, &100i128, &5);
        assert_eq!(skipped, Err(Ok(DEXError::InvalidNonce)));
    }

    #[test]
    fn test_nonce_is_per_account_and_monotonic() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let (_issuer_admin, issuer_id, bond_id, seller) =
            setup_bond_and_holder(&env, 10_000, 5_000);

        let contract_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id, Address::generate(&env)),
        );
        let client = DEXRouterClient::new(&env, &contract_id);

        // One shared, strictly-increasing nonce across all of an account's
        // actions: listing consumes nonce 0, so a cancel replaying nonce 0 fails.
        let order_id = client.list_bond_tokens(
            &seller,
            &bond_id,
            &1_000i128,
            &100i128,
            &Symbol::new(&env, "USDC"),
            &3600u64,
            &0,
        );
        assert_eq!(client.get_nonce(&seller), 1);

        let stale = client.try_cancel_listing(&seller, &order_id, &0);
        assert_eq!(stale, Err(Ok(DEXError::InvalidNonce)));

        // The correct next nonce succeeds.
        client.cancel_listing(&seller, &order_id, &1);
        assert_eq!(client.get_order(&order_id).status, OrderStatus::Cancelled);
    }

    mod property {
        extern crate std;

        use super::*;
        use proptest::prelude::*;

        proptest! {
            #![proptest_config(ProptestConfig {
                cases: 128,
                ..ProptestConfig::default()
            })]

            // Amount * price is exact: the contract never truncates proceeds.
            #[test]
            fn proceeds_is_exact_product(
                amount in 1i128..1_000_000i128,
                price in 1i128..1_000_000_000i128,
            ) {
                let proceeds = amount.checked_mul(price).expect("in-range product");
                prop_assert_eq!(proceeds, amount * price);
                prop_assert!(proceeds >= amount && proceeds >= price);
            }

            // The overflow guard in execute_purchase is equivalent to i128 checked
            // multiplication at the boundary: amount * price overflows iff
            // amount > i128::MAX / price.
            #[test]
            fn overflow_matches_checked_math(
                amount in 1i128..i128::MAX,
                price in 1i128..i128::MAX,
            ) {
                let overflows = amount.checked_mul(price).is_none();
                if overflows {
                    prop_assert!(amount > i128::MAX / price);
                } else {
                    prop_assert!(amount <= i128::MAX / price);
                }
            }

            // Failed purchases (overflow or insufficient escrow) must never mutate
            // the order or any quote balance.
            #[test]
            fn failed_purchase_is_atomic(price in 1i128..i128::MAX) {
                let env = Env::default();
                env.mock_all_auths_allowing_non_root_auth();

                let admin = Address::generate(&env);
                let buyer = Address::generate(&env);
                let order_amount = 1_000i128;
                let (_issuer_admin, issuer_id, bond_id, seller) =
                    setup_bond_and_holder(&env, 1_000_000, order_amount);

                let contract_id = env.register(
                    DEXRouter,
                    (admin.clone(), issuer_id, Address::generate(&env)),
                );
                let client = DEXRouterClient::new(&env, &contract_id);
                let quote = Symbol::new(&env, "USDC");

                let order_id = client.list_bond_tokens(
                    &seller,
                    &bond_id,
                    &order_amount,
                    &price,
                    &quote,
                    &3600u64,
                    &0,
                );

                let overflows = order_amount.checked_mul(price).is_none();
                let res = client.try_execute_purchase(&buyer, &order_id, &price, &order_amount, &0);
                if overflows {
                    prop_assert_eq!(res, Err(Ok(DEXError::Overflow)));
                } else {
                    prop_assert_eq!(res, Err(Ok(DEXError::InsufficientFunds)));
                }

                let order = client.get_order(&order_id);
                prop_assert_eq!(order.status, OrderStatus::Open);
                prop_assert_eq!(order.amount, order_amount);
                prop_assert_eq!(client.get_quote_balance(&buyer, &quote), 0);
                prop_assert_eq!(client.get_quote_balance(&seller, &quote), 0);
            }

            // A fill never reduces an order below its remaining amount, completes
            // via PartiallyFilled -> Filled, and conserves both the quote ledger
            // and the bond supply.
            #[test]
            fn settlement_conserves_balances(
                order_amount in 1i128..50_000i128,
                price in 1i128..100_000i128,
                fill in 1i128..50_000i128,
            ) {
                let env = Env::default();
                env.mock_all_auths_allowing_non_root_auth();

                let admin = Address::generate(&env);
                let buyer = Address::generate(&env);
                let (_issuer_admin, issuer_id, bond_id, seller) =
                    setup_bond_and_holder(&env, 1_000_000, order_amount);

                let contract_id = env.register(
                    DEXRouter,
                    (admin.clone(), issuer_id.clone(), Address::generate(&env)),
                );
                let client = DEXRouterClient::new(&env, &contract_id);
                let issuer_client =
                    nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id);
                let quote = Symbol::new(&env, "USDC");

                let order_id = client.list_bond_tokens(
                    &seller,
                    &bond_id,
                    &order_amount,
                    &price,
                    &quote,
                    &3600u64,
                    &0,
                );

                let first = fill.min(order_amount);
                let deposit = first * price + (order_amount - first) * price;
                client.deposit_quote(&buyer, &quote, &deposit, &0);

                client.execute_purchase(&buyer, &order_id, &price, &first, &1);
                if first < order_amount {
                    let order = client.get_order(&order_id);
                    prop_assert_eq!(order.status, OrderStatus::PartiallyFilled);
                    prop_assert_eq!(order.amount, order_amount - first);

                    let rest = order_amount - first;
                    client.execute_purchase(&buyer, &order_id, &price, &rest, &2);
                }

                let order = client.get_order(&order_id);
                prop_assert_eq!(order.status, OrderStatus::Filled);
                let final_remaining = if first == order_amount {
                    order_amount
                } else {
                    order_amount - first
                };
                prop_assert_eq!(order.amount, final_remaining);

                prop_assert_eq!(client.get_quote_balance(&buyer, &quote), 0);
                prop_assert_eq!(
                    client.get_quote_balance(&seller, &quote),
                    order_amount * price
                );

                let seller_bond = issuer_client.get_holder_balance(&bond_id, &seller);
                let buyer_bond = issuer_client.get_holder_balance(&bond_id, &buyer);
                prop_assert_eq!(seller_bond, 0);
                prop_assert_eq!(buyer_bond, order_amount);
                prop_assert_eq!(seller_bond + buyer_bond, order_amount);
            }

            // The quote ledger tracks a non-negative running balance through an
            // arbitrary interleaving of deposits and withdrawals.
            #[test]
            fn quote_ledger_never_negative(
                deposits in proptest::collection::vec(1i128..100_000i128, 1..20),
                withdrawals in proptest::collection::vec(1i128..100_000i128, 1..20),
            ) {
                let env = Env::default();
                env.mock_all_auths_allowing_non_root_auth();

                let admin = Address::generate(&env);
                let user = Address::generate(&env);
                let contract_id = env.register(
                    DEXRouter,
                    (admin.clone(), Address::generate(&env), Address::generate(&env)),
                );
                let client = DEXRouterClient::new(&env, &contract_id);
                let quote = Symbol::new(&env, "USDC");

                let mut balance = 0i128;
                let mut nonce = 0u64;
                for d in deposits {
                    client.deposit_quote(&user, &quote, &d, &nonce);
                    nonce += 1;
                    balance += d;
                    prop_assert_eq!(client.get_quote_balance(&user, &quote), balance);
                }
                for w in withdrawals {
                    if w <= balance {
                        client.withdraw_quote(&user, &quote, &w, &nonce);
                        balance -= w;
                        nonce += 1;
                    } else {
                        let res = client.try_withdraw_quote(&user, &quote, &w, &nonce);
                        prop_assert_eq!(res, Err(Ok(DEXError::InsufficientFunds)));
                    }
                    prop_assert_eq!(client.get_quote_balance(&user, &quote), balance);
                }
            }
        }
    }
}
