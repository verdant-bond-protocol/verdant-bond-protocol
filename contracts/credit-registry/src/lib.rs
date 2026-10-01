#![no_std]
use nbbs_shared::RegistryError;
use soroban_sdk::{
    contract, contractimpl, contracttype, events::Event, vec, Address, BytesN, Env, IntoVal,
    Symbol, Val, Vec,
};

#[derive(Clone)]
pub enum RegistryEvent {
    CreditTypeRegistered {
        id: u32,
        issuer: Address,
        standard: Symbol,
        precision: u32,
    },
    CreditTypeActivated {
        id: u32,
        caller: Address,
    },
    CreditTypeRejected {
        id: u32,
        caller: Address,
        reason: Symbol,
    },
    AdminChanged {
        prev: Address,
        new: Address,
    },
}

impl Event for RegistryEvent {
    fn topics(&self, env: &Env) -> Vec<Val> {
        let name = match self {
            RegistryEvent::CreditTypeRegistered { .. } => "credit_type_registered",
            RegistryEvent::CreditTypeActivated { .. } => "credit_type_activated",
            RegistryEvent::CreditTypeRejected { .. } => "credit_type_rejected",
            RegistryEvent::AdminChanged { .. } => "admin_changed",
        };
        vec![&env, Symbol::new(env, name).into_val(env)]
    }

    fn data(&self, env: &Env) -> Val {
        match self {
            RegistryEvent::CreditTypeRegistered {
                id,
                issuer,
                standard,
                precision,
            } => (*id, issuer.clone(), standard.clone(), precision).into_val(env),
            RegistryEvent::CreditTypeActivated { id, caller } => (*id, caller.clone()).into_val(env),
            RegistryEvent::CreditTypeRejected { id, caller, reason } => {
                (*id, caller.clone(), reason.clone()).into_val(env)
            }
            RegistryEvent::AdminChanged { prev, new } => (prev.clone(), new.clone()).into_val(env),
        }
    }
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Governance,
    CreditTypeCount,
    CreditType(u32),
    PendingCreditType(u32),
    TimelockExpiry(u32),
    VerificationReference(u32),
    ActivationThreshold,
    Nonce(Address),
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct CreditType {
    pub id: u32,
    pub issuer: Address,
    pub standard: Symbol,
    pub verification_ipfs_hash: BytesN<32>,
    pub decimal_precision: u32,
    pub vintage_min_year: u32,
    pub vintage_max_year: u32,
    pub is_active: bool,
    pub registered_at: u64,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PendingCreditType {
    pub id: u32,
    pub issuer: Address,
    pub standard: Symbol,
    pub verification_ipfs_hash: BytesN<32>,
    pub decimal_precision: u32,
    pub vintage_min_year: u32,
    pub vintage_max_year: u32,
    pub proposed_at: u64,
    pub activation_deadline: u64,
}

const TIMELOCK_SECONDS: u64 = 7 * 24 * 60 * 60;
const MIN_PRECISION: u32 = 0;
const MAX_PRECISION: u32 = 18;

fn require_admin(env: &Env, caller: &Address) -> Result<(), RegistryError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(RegistryError::NotInitialized)?;
    if caller != &admin {
        return Err(RegistryError::Unauthorized);
    }
    Ok(())
}

fn require_governance(env: &Env, caller: &Address) -> Result<(), RegistryError> {
    let governance: Address = env
        .storage()
        .instance()
        .get(&DataKey::Governance)
        .ok_or(RegistryError::NotInitialized)?;
    if caller != &governance {
        return Err(RegistryError::Unauthorized);
    }
    Ok(())
}

fn validate_credit_type_schema(
    precision: u32,
    vintage_min: u32,
    vintage_max: u32,
) -> Result<(), RegistryError> {
    if precision < MIN_PRECISION || precision > MAX_PRECISION {
        return Err(RegistryError::InvalidNonce);
    }
    if vintage_min > vintage_max {
        return Err(RegistryError::InvalidNonce);
    }
    if vintage_max < 1990 || vintage_min > 2100 {
        return Err(RegistryError::InvalidNonce);
    }
    Ok(())
}

fn get_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::Nonce(addr.clone()))
        .unwrap_or(0)
}

fn set_nonce(env: &Env, addr: &Address, nonce: u64) {
    env.storage()
        .instance()
        .set(&DataKey::Nonce(addr.clone()), &nonce);
}

#[contract]
pub struct CreditRegistry;

#[contractimpl]
impl CreditRegistry {
    pub fn __constructor(env: Env, admin: Address, governance: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Governance, &governance);
        env.storage().instance().set(&DataKey::CreditTypeCount, &0u32);
        env.storage().instance().set(&DataKey::ActivationThreshold, &(7 * 24 * 60 * 60)u64);
    }

    pub fn propose_credit_type(
        env: Env,
        caller: Address,
        standard: Symbol,
        issuer: Address,
        verification_ipfs_hash: BytesN<32>,
        decimal_precision: u32,
        vintage_min_year: u32,
        vintage_max_year: u32,
        nonce: u64,
    ) -> Result<u32, RegistryError> {
        caller.require_auth();
        require_governance(&env, &caller)?;

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }

        validate_credit_type_schema(decimal_precision, vintage_min_year, vintage_max_year)?;

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::CreditTypeCount)
            .unwrap_or(0);
        let id = count + 1;

        let now = env.ledger().timestamp();
        let activation_deadline = now + TIMELOCK_SECONDS;

        let pending = PendingCreditType {
            id,
            issuer: issuer.clone(),
            standard: standard.clone(),
            verification_ipfs_hash: verification_ipfs_hash.clone(),
            decimal_precision,
            vintage_min_year,
            vintage_max_year,
            proposed_at: now,
            activation_deadline,
        };

        env.storage()
            .instance()
            .set(&DataKey::PendingCreditType(id), &pending);
        env.storage()
            .instance()
            .set(&DataKey::TimelockExpiry(id), &activation_deadline);

        set_nonce(&env, &caller, nonce + 1);

        env.events().publish((
            RegistryEvent::CreditTypeRegistered {
                id,
                issuer: issuer.clone(),
                standard: standard.clone(),
                precision: decimal_precision,
            },
        ));

        Ok(id)
    }

    pub fn activate_credit_type(
        env: Env,
        caller: Address,
        credit_type_id: u32,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        caller.require_auth();
        require_governance(&env, &caller)?;

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }

        let pending: PendingCreditType = env
            .storage()
            .instance()
            .get(&DataKey::PendingCreditType(credit_type_id))
            .ok_or(RegistryError::NotInitialized)?;

        let now = env.ledger().timestamp();
        if now < pending.activation_deadline {
            return Err(RegistryError::Unauthorized);
        }

        let active_credit_type = CreditType {
            id: pending.id,
            issuer: pending.issuer,
            standard: pending.standard.clone(),
            verification_ipfs_hash: pending.verification_ipfs_hash,
            decimal_precision: pending.decimal_precision,
            vintage_min_year: pending.vintage_min_year,
            vintage_max_year: pending.vintage_max_year,
            is_active: true,
            registered_at: now,
        };

        env.storage()
            .instance()
            .set(&DataKey::CreditType(credit_type_id), &active_credit_type);
        env.storage().instance().remove(&DataKey::PendingCreditType(credit_type_id));
        env.storage().instance().remove(&DataKey::TimelockExpiry(credit_type_id));

        set_nonce(&env, &caller, nonce + 1);

        env.events().publish((RegistryEvent::CreditTypeActivated {
            id: credit_type_id,
            caller: caller.clone(),
        }));

        Ok(())
    }

    pub fn reject_credit_type(
        env: Env,
        caller: Address,
        credit_type_id: u32,
        reason: Symbol,
        nonce: u64,
    ) -> Result<(), RegistryError> {
        caller.require_auth();
        require_governance(&env, &caller)?;

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }

        env.storage().instance().remove(&DataKey::PendingCreditType(credit_type_id));
        env.storage().instance().remove(&DataKey::TimelockExpiry(credit_type_id));

        set_nonce(&env, &caller, nonce + 1);

        env.events().publish((RegistryEvent::CreditTypeRejected {
            id: credit_type_id,
            caller: caller.clone(),
            reason,
        }));

        Ok(())
    }

    pub fn get_credit_type(env: Env, credit_type_id: u32) -> Result<CreditType, RegistryError> {
        env.storage()
            .instance()
            .get(&DataKey::CreditType(credit_type_id))
            .ok_or(RegistryError::NotInitialized)
    }

    pub fn get_pending_credit_type(
        env: Env,
        credit_type_id: u32,
    ) -> Result<PendingCreditType, RegistryError> {
        env.storage()
            .instance()
            .get(&DataKey::PendingCreditType(credit_type_id))
            .ok_or(RegistryError::NotInitialized)
    }

    pub fn credit_type_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::CreditTypeCount)
            .unwrap_or(0)
    }

    pub fn is_credit_type_active(env: Env, credit_type_id: u32) -> bool {
        env.storage()
            .instance()
            .get::<DataKey, CreditType>(&DataKey::CreditType(credit_type_id))
            .map(|ct| ct.is_active)
            .unwrap_or(false)
    }

    pub fn get_nonce(env: Env, address: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::Nonce(address))
            .unwrap_or(0)
    }

    pub fn set_admin(env: Env, caller: Address, new_admin: Address, nonce: u64) -> Result<(), RegistryError> {
        caller.require_auth();
        require_admin(&env, &caller)?;

        let expected_nonce = get_nonce(&env, &caller);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }

        env.storage().instance().set(&DataKey::Admin, &new_admin);
        set_nonce(&env, &caller, nonce + 1);

        env.events().publish((RegistryEvent::AdminChanged {
            prev: caller,
            new: new_admin,
        }));

        Ok(())
    }
}
