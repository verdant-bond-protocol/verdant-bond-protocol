import re

with open('contracts/coupon-engine/src/lib.rs', 'r') as f:
    content = f.read()

# Add EscrowedCredits to DataKey
content = content.replace(
    'AccruedCredits(u64, Address),',
    'AccruedCredits(u64, Address),\n    EscrowedCredits(u64, Address),'
)

# Rename accrue_credits to escrow_credits for the escrowing phase
accrue_fn = """fn escrow_credits(
    env: &Env,
    bond_id: u64,
    period_index: u32,
    holder: Address,
    credit_type: CreditType,
    amount: i128,
) -> Result<(), BondError> {
    let key = DataKey::EscrowedCredits(bond_id, holder);
    let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    env.storage().persistent().set(
        &key,
        &current.checked_add(amount).ok_or(BondError::Overflow)?,
    );
    Ok(())
}

fn accrue_credits("""

content = content.replace('fn accrue_credits(', accrue_fn)

# In distribute_coupon_batch, call escrow_credits instead of accrue_credits
content = content.replace(
    'accrue_credits(\n                                &env,\n                                bond_id,\n                                period_index,\n                                holder.clone(),\n                                CreditType::Carbon,\n                                holder_credits,\n                            )?;',
    'escrow_credits(&env, bond_id, period_index, holder.clone(), CreditType::Carbon, holder_credits)?;'
)

content = content.replace(
    'accrue_credits(\n                                &env,\n                                bond_id,\n                                period_index,\n                                holder.clone(),\n                                CreditType::Biodiversity,\n                                holder_credits,\n                            )?;',
    'escrow_credits(&env, bond_id, period_index, holder.clone(), CreditType::Biodiversity, holder_credits)?;'
)

content = content.replace(
    'accrue_credits(\n                                    &env,\n                                    bond_id,\n                                    period_index,\n                                    holder.clone(),\n                                    CreditType::Carbon,\n                                    carbon_holder,\n                                )?;',
    'escrow_credits(&env, bond_id, period_index, holder.clone(), CreditType::Carbon, carbon_holder)?;'
)

content = content.replace(
    'accrue_credits(\n                                    &env,\n                                    bond_id,\n                                    period_index,\n                                    holder.clone(),\n                                    CreditType::Biodiversity,\n                                    biodiversity_holder,\n                                )?;',
    'escrow_credits(&env, bond_id, period_index, holder.clone(), CreditType::Biodiversity, biodiversity_holder)?;'
)

# Add confirm_retirement and revert_retirement functions to CouponEngine
saga_functions = """
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

        // Note: The actual retirement record is assumed to be handled by the credit-retirement contract
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
        env.storage().persistent().get(&DataKey::EscrowedCredits(bond_id, holder)).unwrap_or(0)
    }
"""

content = content.replace('pub fn accrued_credits(', saga_functions + '\n    pub fn accrued_credits(')

with open('contracts/coupon-engine/src/lib.rs', 'w') as f:
    f.write(content)
