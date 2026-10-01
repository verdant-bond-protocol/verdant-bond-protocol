import re

with open('contracts/coupon-engine/src/lib.rs', 'r') as f:
    content = f.read()

# Replace AccruedCredits to EscrowedCredits
content = content.replace('AccruedCredits', 'EscrowedCredits')
content = content.replace('accrued_credits', 'escrowed_credits')
content = content.replace('accrue_credits', 'escrow_credits')

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

# Wait, `escrowed_credits` already exists because I renamed `accrued_credits` to `escrowed_credits`!
# So I don't need to add `escrowed_credits` again.

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
"""

content = content.replace('pub fn escrowed_credits(', saga_functions + '\n    pub fn escrowed_credits(')

with open('contracts/coupon-engine/src/lib.rs', 'w') as f:
    f.write(content)
