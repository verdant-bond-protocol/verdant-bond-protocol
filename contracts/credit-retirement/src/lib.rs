#![no_std]
#![allow(deprecated)]
use nbbs_shared::{CreditError, CreditType};
use soroban_sdk::{
    contract, contractimpl, contracttype, vec, Address, BytesN, Env, IntoVal, Symbol, Vec,
};

/// Issue #188: versioned-interface convention. Bump on a breaking storage
/// layout or interface change; see docs/upgrade-migrations.md.
pub const SCHEMA_VERSION: u32 = 1;


#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Retirement(u64),
    RetirementCount,
    HolderRetirements(Address),
    RetiredCredits(Address),
    RetiredPerBond(u64, Address),
    BondIssuerAddress,
    CouponEngineAddress,
    Nonce(Address),
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct RetirementRecord {
    pub id: u64,
    pub holder: Address,
    pub bond_id: u64,
    pub amount: i128,
    pub credit_type: CreditType,
    pub retired_at: u64,
    pub certificate_ipfs_hash: BytesN<32>,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct RetirementCertificate {
    pub record_id: u64,
    pub holder: Address,
    pub bond_id: u64,
    pub amount: i128,
    pub credit_type: CreditType,
    pub retired_at: u64,
    pub certificate_hash: BytesN<32>,
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

#[contract]
pub struct CreditRetirement;

#[contractimpl]
impl CreditRetirement {
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

    pub fn retire_credits(
        env: Env,
        holder: Address,
        bond_id: u64,
        amount: i128,
        credit_type: CreditType,
        certificate_hash: BytesN<32>,
        nonce: u64,
    ) -> Result<u64, CreditError> {
        holder.require_auth();

        let expected_nonce = get_nonce(&env, &holder);
        if nonce != expected_nonce {
            return Err(CreditError::InvalidNonce);
        }
        set_nonce(&env, &holder, expected_nonce + 1);

        if amount <= 0 {
            return Err(CreditError::InsufficientCredits);
        }

        if certificate_hash.to_array().iter().all(|b| *b == 0) {
            return Err(CreditError::InvalidCertificate);
        }

        let bond_issuer: Address = env
            .storage()
            .instance()
            .get(&DataKey::BondIssuerAddress)
            .ok_or(CreditError::NotInitialized)?;
        let balance: i128 = env.invoke_contract(
            &bond_issuer,
            &Symbol::new(&env, "get_holder_balance"),
            vec![&env, bond_id.into_val(&env), holder.clone().into_val(&env)],
        );
        if balance <= 0 {
            return Err(CreditError::NotAHolder);
        }

        let coupon_engine: Address = env
            .storage()
            .instance()
            .get(&DataKey::CouponEngineAddress)
            .ok_or(CreditError::NotInitialized)?;
        let accrued: i128 = env.invoke_contract(
            &coupon_engine,
            &Symbol::new(&env, "accrued_credits"),
            vec![&env, bond_id.into_val(&env), holder.clone().into_val(&env)],
        );

        if amount > accrued {
            return Err(CreditError::InsufficientCredits);
        }

        // Settle against the coupon ledger before minting anything: the same
        // credits must not be retirable here and later claimable there.
        env.invoke_contract::<()>(
            &coupon_engine,
            &Symbol::new(&env, "consume_credits"),
            vec![
                &env,
                holder.clone().into_val(&env),
                bond_id.into_val(&env),
                amount.into_val(&env),
            ],
        );

        let retired_key = DataKey::RetiredPerBond(bond_id, holder.clone());
        let already_retired: i128 = env.storage().instance().get(&retired_key).unwrap_or(0);
        env.storage()
            .instance()
            .set(&retired_key, &(already_retired + amount));

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::RetirementCount)
            .unwrap_or(0);
        let retirement_id = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::RetirementCount, &retirement_id);

        let now = env.ledger().timestamp();
        let record = RetirementRecord {
            id: retirement_id,
            holder: holder.clone(),
            bond_id,
            amount,
            credit_type,
            retired_at: now,
            certificate_ipfs_hash: certificate_hash.clone(),
        };

        env.storage()
            .instance()
            .set(&DataKey::Retirement(retirement_id), &record);

        let retired: i128 = env
            .storage()
            .instance()
            .get(&DataKey::RetiredCredits(holder.clone()))
            .unwrap_or(0);
        let new_total = retired
            .checked_add(amount)
            .ok_or(CreditError::InsufficientCredits)?;
        env.storage()
            .instance()
            .set(&DataKey::RetiredCredits(holder.clone()), &new_total);

        let mut retirements: Vec<u64> = env
            .storage()
            .instance()
            .get(&DataKey::HolderRetirements(holder.clone()))
            .unwrap_or(vec![&env]);
        retirements.push_back(retirement_id);
        env.storage()
            .instance()
            .set(&DataKey::HolderRetirements(holder.clone()), &retirements);

        env.events().publish(
            (Symbol::new(&env, "credits_retired"),),
            (holder.clone(), amount, credit_type),
        );

        Ok(retirement_id)
    }

    pub fn get_retirement_record(
        env: Env,
        retirement_id: u64,
    ) -> Result<RetirementRecord, CreditError> {
        env.storage()
            .instance()
            .get(&DataKey::Retirement(retirement_id))
            .ok_or(CreditError::InsufficientCredits)
    }

    pub fn get_retirement_certificate(
        env: Env,
        retirement_id: u64,
    ) -> Result<RetirementCertificate, CreditError> {
        let record: RetirementRecord = env
            .storage()
            .instance()
            .get(&DataKey::Retirement(retirement_id))
            .ok_or(CreditError::InsufficientCredits)?;

        Ok(RetirementCertificate {
            record_id: record.id,
            holder: record.holder,
            bond_id: record.bond_id,
            amount: record.amount,
            credit_type: record.credit_type,
            retired_at: record.retired_at,
            certificate_hash: record.certificate_ipfs_hash,
        })
    }

    pub fn get_holder_retirements(env: Env, holder: Address) -> Vec<u64> {
        env.storage()
            .instance()
            .get(&DataKey::HolderRetirements(holder))
            .unwrap_or(vec![&env])
    }

    pub fn get_total_retired(env: Env, holder: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::RetiredCredits(holder))
            .unwrap_or(0)
    }

    pub fn total_retirements(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::RetirementCount)
            .unwrap_or(0)
    }

    pub fn set_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
        nonce: u64,
    ) -> Result<(), CreditError> {
        current_admin.require_auth();

        let expected_nonce = get_nonce(&env, &current_admin);
        if nonce != expected_nonce {
            return Err(CreditError::InvalidNonce);
        }
        set_nonce(&env, &current_admin, expected_nonce + 1);

        require_admin(&env, &current_admin)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (Symbol::new(&env, "admin_changed"),),
            (current_admin, new_admin),
        );

        Ok(())
    }

    pub fn get_admin(env: Env) -> Result<Address, CreditError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(CreditError::NotInitialized)
    /// Issue #188: versioned-interface convention — bump when the contract's
    /// storage layout or callable interface changes in a breaking way. See
    /// docs/upgrade-migrations.md.
    pub fn schema_version(env: Env) -> u32 {
        let _ = env;
        SCHEMA_VERSION
    }
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), CreditError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(CreditError::NotInitialized)?;
    if caller != &admin {
        return Err(CreditError::Unauthorized);
    }
    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;
    use nbbs_bond_issuer::{BondIssuer, BondIssuerClient};
    use nbbs_coupon_engine::{CouponEngine, CouponEngineClient};
    use nbbs_shared::{BiodiversityMetrics, BondConfig};
    use soroban_sdk::{testutils::Address as _, vec as svec, BytesN, Env, Symbol};

    fn make_certificate_hash(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = value;
        BytesN::from_array(env, &arr)
    }

    fn make_project_id(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[31] = value;
        BytesN::from_array(env, &arr)
    }

    fn submit_verified_report(
        env: &Env,
        admin: &Address,
        oracle_id: &Address,
        project_id: &BytesN<32>,
        carbon: i128,
    ) -> u64 {
        let oc_client = nbbs_oracle_consumer::OracleConsumerClient::new(env, oracle_id);
        let provider = Address::generate(env);
        oc_client.register_provider(admin, &provider, &Symbol::new(env, "verra_vcs"), &0);
        let report_id = oc_client.submit_report(
            &provider,
            project_id,
            &1000u64,
            &2000u64,
            &carbon,
            &BiodiversityMetrics::Absent,
            &Symbol::new(env, "verra_vcs"),
            &make_certificate_hash(env, 9),
            &0,
        );
        oc_client.verify_report(admin, &report_id, &1);

        // DEFAULT_SIGNATURE_THRESHOLD is 2, so the admin's verification alone
        // leaves the report Pending. Register a second, independently staked
        // verifier to reach the threshold, matching the oracle design doc and
        // coupon-engine's submit_verified_report helper.
        let second_verifier = Address::generate(env);
        oc_client.register_provider(admin, &second_verifier, &Symbol::new(env, "satellite"), &2);
        oc_client.add_stake(
            &second_verifier,
            &nbbs_oracle_consumer::DEFAULT_MIN_VERIFIER_STAKE,
            &0,
        );
        oc_client.verify_report(&second_verifier, &report_id, &1);

        report_id
    }

    struct Setup {
        _env: Env,
        client: CreditRetirementClient<'static>,
        admin: Address,
        holder: Address,
        bond_id: u64,
        accrued: i128,
        ce_client: CouponEngineClient<'static>,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let holder = Address::generate(&env);
        let project_id = make_project_id(&env, 1);

        let issuer_admin = Address::generate(&env);
        let issuer_id = env.register(BondIssuer, (issuer_admin.clone(),));
        let issuer_client = BondIssuerClient::new(&env, &issuer_id);

        let bond_config = BondConfig {
            project_id: project_id.clone(),
            face_value: 1000,
            coupon_schedule: svec![&env, 1_000_000u64, 2_000_000u64],
            credit_type: CreditType::Carbon,
            maturity_date: 3_000_000,
            total_supply: 10_000,
        };
        let bond_id = issuer_client.issue_bond(&issuer_admin, &bond_config, &0);
        issuer_client.subscribe(&holder, &bond_id, &10_000, &0);

        let oracle_id = env.register(nbbs_oracle_consumer::OracleConsumer, (admin.clone(),));
        let report_id = submit_verified_report(&env, &admin, &oracle_id, &project_id, 100_000);

        let ce_id = env.register(
            CouponEngine,
            (admin.clone(), issuer_id.clone(), oracle_id.clone()),
        );
        let ce_client = CouponEngineClient::new(&env, &ce_id);
        ce_client.register_bond(&admin, &bond_id, &project_id, &0);

        let holders = svec![&env, holder.clone()];
        ce_client.distribute_coupon(&admin, &bond_id, &0, &holders, &report_id, &1);
        let accrued = ce_client.accrued_credits(&bond_id, &holder);
        assert!(accrued > 0);

        let contract_id = env.register(
            CreditRetirement,
            (admin.clone(), issuer_id.clone(), ce_id.clone()),
        );
        let client = CreditRetirementClient::new(&env, &contract_id);

        Setup {
            _env: env,
            client,
            admin,
            holder,
            bond_id,
            accrued,
            ce_client,
        }
    }

    #[test]
    fn test_retire_debits_coupon_ledger_and_blocks_double_spend() {
        let s = setup();
        let half = s.accrued / 2;

        s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &half,
            &CreditType::Carbon,
            &make_certificate_hash(&s._env, 1),
            &0,
        );
        assert_eq!(
            s.ce_client.accrued_credits(&s.bond_id, &s.holder),
            s.accrued - half
        );

        s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &(s.accrued - half),
            &CreditType::Carbon,
            &make_certificate_hash(&s._env, 2),
            &1,
        );
        assert_eq!(s.ce_client.accrued_credits(&s.bond_id, &s.holder), 0);

        // Retired credits are gone from the coupon ledger, so a claim after
        // retirement yields nothing.
        assert_eq!(s.ce_client.claim_credits(&s.holder, &s.bond_id, &0), 0);
        assert_eq!(s.client.get_total_retired(&s.holder), s.accrued);
    }

    #[test]
    fn test_retire_credits_and_query() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let id = s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(id, 1);

        let record = s.client.get_retirement_record(&id);
        assert_eq!(record.holder, s.holder);
        assert_eq!(record.bond_id, s.bond_id);
        assert_eq!(record.amount, s.accrued);
        assert_eq!(record.credit_type, CreditType::Carbon);
        assert_eq!(record.certificate_ipfs_hash, hash);

        let cert = s.client.get_retirement_certificate(&id);
        assert_eq!(cert.record_id, id);
        assert_eq!(cert.holder, s.holder);
        assert_eq!(cert.amount, s.accrued);
        assert_eq!(cert.certificate_hash, hash);

        assert_eq!(s.client.total_retirements(), 1);
    }

    #[test]
    fn test_multiple_retirements_and_total() {
        let s = setup();
        let half = s.accrued / 2;
        let second = s.accrued - half;

        let hash1 = make_certificate_hash(&s._env, 1);
        let id1 = s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &half,
            &CreditType::Carbon,
            &hash1,
            &0,
        );

        let hash2 = make_certificate_hash(&s._env, 2);
        let id2 = s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &second,
            &CreditType::Biodiversity,
            &hash2,
            &1,
        );

        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
        assert_eq!(s.client.total_retirements(), 2);

        assert_eq!(s.client.get_total_retired(&s.holder), s.accrued);

        let retirements = s.client.get_holder_retirements(&s.holder);
        assert_eq!(retirements.len(), 2);
    }

    #[test]
    fn test_retire_zero_credits_rejected() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &0i128,
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::InsufficientCredits)));
    }

    #[test]
    fn test_retire_zero_certificate_hash_rejected() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 0);
        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::InvalidCertificate)));
    }

    #[test]
    fn test_retire_without_holding_bond_rejected() {
        let s = setup();

        let stranger = Address::generate(&s._env);
        let hash = make_certificate_hash(&s._env, 1);
        let result = s.client.try_retire_credits(
            &stranger,
            &s.bond_id,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::NotAHolder)));
    }

    #[test]
    fn test_retire_more_than_accrued_rejected() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &(s.accrued + 1),
            &CreditType::Carbon,
            &hash,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::InsufficientCredits)));
    }

    #[test]
    fn test_double_retirement_of_same_accrual_rejected() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        s.client.retire_credits(
            &s.holder,
            &s.bond_id,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &0,
        );

        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &1i128,
            &CreditType::Carbon,
            &hash,
            &1,
        );
        assert_eq!(result, Err(Ok(CreditError::InsufficientCredits)));
    }

    #[test]
    fn test_query_nonexistent_retirement() {
        let s = setup();
        let result = s.client.try_get_retirement_record(&999);
        assert_eq!(result, Err(Ok(CreditError::InsufficientCredits)));
    }

    #[test]
    fn test_multiple_holders_tracked_independently() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let holder1 = Address::generate(&env);
        let holder2 = Address::generate(&env);
        let project_id = make_project_id(&env, 3);

        let issuer_admin = Address::generate(&env);
        let issuer_id = env.register(BondIssuer, (issuer_admin.clone(),));
        let issuer_client = BondIssuerClient::new(&env, &issuer_id);

        let bond_config = BondConfig {
            project_id: project_id.clone(),
            face_value: 1000,
            coupon_schedule: svec![&env, 1_000_000u64, 2_000_000u64],
            credit_type: CreditType::Carbon,
            maturity_date: 3_000_000,
            total_supply: 10_000,
        };
        let bond_id = issuer_client.issue_bond(&issuer_admin, &bond_config, &0);
        issuer_client.subscribe(&holder1, &bond_id, &3_000, &0);
        issuer_client.subscribe(&holder2, &bond_id, &7_000, &0);

        let oracle_id = env.register(nbbs_oracle_consumer::OracleConsumer, (admin.clone(),));
        let report_id = submit_verified_report(&env, &admin, &oracle_id, &project_id, 100_000);

        let ce_id = env.register(
            CouponEngine,
            (admin.clone(), issuer_id.clone(), oracle_id.clone()),
        );
        let ce_client = CouponEngineClient::new(&env, &ce_id);
        ce_client.register_bond(&admin, &bond_id, &project_id, &0);

        let holders = svec![&env, holder1.clone(), holder2.clone()];
        ce_client.distribute_coupon(&admin, &bond_id, &0, &holders, &report_id, &1);

        let accrued1 = ce_client.accrued_credits(&bond_id, &holder1);
        let accrued2 = ce_client.accrued_credits(&bond_id, &holder2);
        assert!(accrued1 > 0);
        assert!(accrued2 > 0);

        let cr_id = env.register(CreditRetirement, (admin, issuer_id.clone(), ce_id.clone()));
        let cr_client = CreditRetirementClient::new(&env, &cr_id);

        let hash1 = make_certificate_hash(&env, 1);
        cr_client.retire_credits(
            &holder1,
            &bond_id,
            &accrued1,
            &CreditType::Carbon,
            &hash1,
            &0,
        );

        let hash2 = make_certificate_hash(&env, 2);
        cr_client.retire_credits(
            &holder2,
            &bond_id,
            &accrued2,
            &CreditType::Biodiversity,
            &hash2,
            &0,
        );

        assert_eq!(cr_client.get_total_retired(&holder1), accrued1);
        assert_eq!(cr_client.get_total_retired(&holder2), accrued2);
        assert_eq!(cr_client.total_retirements(), 2);

        let result = cr_client.try_retire_credits(
            &holder1,
            &bond_id,
            &1i128,
            &CreditType::Carbon,
            &hash1,
            &1,
        );
        assert_eq!(result, Err(Ok(CreditError::InsufficientCredits)));

        let result = cr_client.try_retire_credits(
            &Address::generate(&env),
            &bond_id,
            &1i128,
            &CreditType::Carbon,
            &hash1,
            &0,
        );
        assert_eq!(result, Err(Ok(CreditError::NotAHolder)));
    }

    #[test]
    fn test_empty_total_retirements() {
        let s = setup();
        assert_eq!(s.client.total_retirements(), 0);
        let empty: Vec<u64> = vec![&s._env];
        assert_eq!(s.client.get_holder_retirements(&s.holder), empty);
        assert_eq!(s.client.get_total_retired(&s.holder), 0);
    }

    #[test]
    fn test_invalid_nonce_rejected() {
        let s = setup();

        let hash = make_certificate_hash(&s._env, 1);
        let result = s.client.try_retire_credits(
            &s.holder,
            &s.bond_id,
            &s.accrued,
            &CreditType::Carbon,
            &hash,
            &1,
        );
        assert_eq!(result, Err(Ok(CreditError::InvalidNonce)));
    }

    #[test]
    fn test_admin_rotation_requires_current_admin() {
        let s = setup();
        let new_admin = Address::generate(&s._env);
        let stranger = Address::generate(&s._env);

        let result = s.client.try_set_admin(&stranger, &new_admin, &0);
        assert_eq!(result, Err(Ok(CreditError::Unauthorized)));
        assert_eq!(s.client.get_admin(), s.admin);

        s.client.set_admin(&s.admin, &new_admin, &0);
        assert_eq!(s.client.get_admin(), new_admin);

        let another_admin = Address::generate(&s._env);
        let result = s.client.try_set_admin(&s.admin, &another_admin, &1);
        assert_eq!(result, Err(Ok(CreditError::Unauthorized)));
    }
}
