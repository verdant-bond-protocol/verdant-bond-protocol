use super::*;

fn factor(env: &Env, method: &str, numerator: i128, denominator: i128) -> EquivalenceFactor {
    EquivalenceFactor {
        methodology: Symbol::new(env, method),
        numerator,
        denominator,
    }
}

fn table(env: &Env, vcs: i128, gs: i128) -> Vec<EquivalenceFactor> {
    vec![
        env,
        factor(env, "verra_vcs", vcs, 100),
        factor(env, "gold_standard", gs, 100),
    ]
}

fn provision(t: &TestEnv) -> Address {
    let governance = Address::generate(&t._env);
    t.client
        .set_equivalence_governance(&t.admin, &governance, &t.client.get_nonce(&t.admin));
    governance
}

fn issue(t: &TestEnv, project: &BytesN<32>, holder: &Address, kind: CreditType) -> u64 {
    let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
    let bond = issuer.issue_bond(
        &t.issuer_admin,
        &make_bond_config_with_type(&t._env, project, kind),
        &issuer.get_nonce(&t.issuer_admin),
    );
    issuer.subscribe(holder, &bond, &10_000, &issuer.get_nonce(holder));
    t.client
        .register_bond(&t.admin, &bond, project, &t.client.get_nonce(&t.admin));
    bond
}

fn report(
    t: &TestEnv,
    project: &BytesN<32>,
    method: &str,
    carbon: i128,
    start: u64,
    end: u64,
    biodiversity: BiodiversityMetrics,
) -> u64 {
    let env = &t._env;
    let oracle = nbbs_oracle_consumer::OracleConsumerClient::new(env, &t.oracle_id);
    let provider = Address::generate(env);
    let nonce = oracle.get_nonce(&t.admin);
    oracle.register_provider(&t.admin, &provider, &Symbol::new(env, method), &nonce);
    let id = oracle.submit_report(
        &provider,
        project,
        &start,
        &end,
        &carbon,
        &biodiversity,
        &Symbol::new(env, method),
        &make_ipfs_hash(env, 1),
        &0,
    );
    oracle.verify_report(&t.admin, &id, &(nonce + 1));
    let verifier = Address::generate(env);
    oracle.register_provider(
        &t.admin,
        &verifier,
        &Symbol::new(env, "satellite"),
        &(nonce + 2),
    );
    oracle.add_stake(
        &verifier,
        &nbbs_oracle_consumer::DEFAULT_MIN_VERIFIER_STAKE,
        &0,
    );
    oracle.verify_report(&verifier, &id, &1);
    id
}

#[test]
fn multi_registry_portfolio_records_and_replays_historical_versions() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let t = deploy(env, admin);
    let governance = provision(&t);
    t.client.publish_equivalence(
        &governance,
        &0,
        &table(&t._env, 100, 80),
        &make_ipfs_hash(&t._env, 1),
        &0,
    );
    let holder = Address::generate(&t._env);
    let vcs_project = create_project_id(&t._env, 80);
    let gs_project = create_project_id(&t._env, 81);
    let vcs = issue(&t, &vcs_project, &holder, CreditType::Carbon);
    let gs = issue(&t, &gs_project, &holder, CreditType::Carbon);
    for (bond, project, method, expected) in [
        (vcs, &vcs_project, "verra_vcs", 100_000_000),
        (gs, &gs_project, "gold_standard", 80_000_000),
    ] {
        let id = report(
            &t,
            project,
            method,
            100_000,
            1000,
            2000,
            BiodiversityMetrics::Absent,
        );
        let result = t.client.distribute_coupon(
            &t.admin,
            &bond,
            &0,
            &vec![&t._env, holder.clone()],
            &id,
            &t.client.get_nonce(&t.admin),
        );
        assert_eq!(result.total_credits, expected);
        let audit = t.client.get_coupon_calculation(&bond, &0).unwrap();
        assert_eq!(audit.table_version, 1);
        assert_eq!(audit.normalized_carbon * 1000, expected);
        assert_eq!(
            audit.normalized_carbon,
            t.client.replay_coupon_conversion(&bond, &0)
        );
    }
    let old = t.client.get_coupon_calculation(&gs, &0).unwrap();
    let old_table = t.client.get_equivalence_table(&1).unwrap();
    t.client.publish_equivalence(
        &governance,
        &1,
        &table(&t._env, 100, 50),
        &make_ipfs_hash(&t._env, 2),
        &1,
    );
    let id = report(
        &t,
        &gs_project,
        "gold_standard",
        100_000,
        2000,
        3000,
        BiodiversityMetrics::Absent,
    );
    let result = t.client.distribute_coupon(
        &t.admin,
        &gs,
        &1,
        &vec![&t._env, holder],
        &id,
        &t.client.get_nonce(&t.admin),
    );
    assert_eq!(result.total_credits, 50_000_000);
    assert_eq!(
        t.client
            .get_coupon_calculation(&gs, &1)
            .unwrap()
            .table_version,
        2
    );
    assert_eq!(t.client.get_coupon_calculation(&gs, &0).unwrap(), old);
    assert_eq!(t.client.get_equivalence_table(&1).unwrap(), old_table);
    assert_eq!(t.client.replay_coupon_conversion(&gs, &0), 80_000);
}

#[test]
fn conversion_and_ownership_stay_pinned_across_batches_and_table_updates() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let t = deploy(env, admin);
    let governance = provision(&t);
    t.client.publish_equivalence(
        &governance,
        &0,
        &table(&t._env, 100, 80),
        &make_ipfs_hash(&t._env, 1),
        &0,
    );
    let project = create_project_id(&t._env, 82);
    let a = Address::generate(&t._env);
    let b = Address::generate(&t._env);
    let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
    let bond = issuer.issue_bond(&t.issuer_admin, &make_bond_config(&t._env, &project), &0);
    issuer.subscribe(&a, &bond, &5000, &0);
    issuer.subscribe(&b, &bond, &5000, &0);
    t.client
        .register_bond(&t.admin, &bond, &project, &t.client.get_nonce(&t.admin));
    let id = report(
        &t,
        &project,
        "gold_standard",
        100_000,
        1000,
        2000,
        BiodiversityMetrics::Absent,
    );
    let holders = vec![&t._env, a.clone(), b.clone()];
    t.client.distribute_coupon_batch(
        &t.admin,
        &bond,
        &0,
        &holders,
        &id,
        &0,
        &1,
        &t.client.get_nonce(&t.admin),
    );
    let pinned = t.client.get_coupon_calculation(&bond, &0).unwrap();
    assert_eq!(pinned.balance_version, 2);
    t._env.as_contract(&t.client.address, || {
        t._env.storage().persistent().remove(&(
            Symbol::new(&t._env, "CreditCouponCalculation"),
            bond,
            0u32,
        ));
    });
    t.client.publish_equivalence(
        &governance,
        &1,
        &table(&t._env, 100, 50),
        &make_ipfs_hash(&t._env, 2),
        &1,
    );
    issuer.transfer(&b, &a, &bond, &5000, &1);
    let result = t.client.distribute_coupon_batch(
        &t.admin,
        &bond,
        &0,
        &holders,
        &id,
        &1,
        &1,
        &t.client.get_nonce(&t.admin),
    );
    assert_eq!(result.total_credits, 80_000_000);
    assert_eq!(t.client.escrowed_credits(&bond, &a), 40_000_000);
    assert_eq!(t.client.escrowed_credits(&bond, &b), 40_000_000);
    assert_eq!(t.client.get_coupon_calculation(&bond, &0).unwrap(), pinned);
    assert_eq!(issuer.get_holder_balance(&bond, &b), 0);
    assert_eq!(
        issuer.get_holder_balance_at_version(&bond, &b, &pinned.balance_version),
        5000
    );
}

#[test]
fn tables_reject_unauthorized_stale_duplicate_and_invalid_updates() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let t = deploy(env, admin);
    let governance = provision(&t);
    let hash = make_ipfs_hash(&t._env, 1);
    assert_eq!(
        t.client
            .try_set_equivalence_governance(&t.admin, &governance, &1),
        Err(Ok(BondError::InvalidEquivalence))
    );
    assert_eq!(
        t.client
            .try_publish_equivalence(&t.admin, &0, &table(&t._env, 100, 80), &hash, &1),
        Err(Ok(BondError::Unauthorized))
    );
    for entries in [
        vec![&t._env],
        vec![&t._env, factor(&t._env, "verra_vcs", 0, 1)],
        vec![&t._env, factor(&t._env, "verra_vcs", 1, 0)],
        vec![
            &t._env,
            factor(&t._env, "verra_vcs", 1, 1),
            factor(&t._env, "verra_vcs", 2, 1),
        ],
    ] {
        assert_eq!(
            t.client
                .try_publish_equivalence(&governance, &0, &entries, &hash, &0),
            Err(Ok(BondError::InvalidEquivalence))
        );
    }
    assert_eq!(t.client.get_equivalence_version(), 0);
    assert_eq!(t.client.get_nonce(&governance), 0);
    t.client
        .publish_equivalence(&governance, &0, &table(&t._env, 100, 80), &hash, &0);
    assert_eq!(
        t.client
            .try_publish_equivalence(&governance, &0, &table(&t._env, 100, 50), &hash, &1),
        Err(Ok(BondError::InvalidEquivalence))
    );
    assert_eq!(t.client.get_equivalence_version(), 1);
}

#[test]
fn missing_methodology_fails_closed_and_failed_distribution_leaves_no_calculation() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let t = deploy(env, admin);
    let governance = provision(&t);
    t.client.publish_equivalence(
        &governance,
        &0,
        &vec![&t._env, factor(&t._env, "verra_vcs", 1, 1)],
        &make_ipfs_hash(&t._env, 1),
        &0,
    );
    let project = create_project_id(&t._env, 83);
    let holder = Address::generate(&t._env);
    let bond = issue(&t, &project, &holder, CreditType::Carbon);
    let id = report(
        &t,
        &project,
        "gold_standard",
        100_000,
        1000,
        2000,
        BiodiversityMetrics::Absent,
    );
    assert_eq!(
        t.client.try_distribute_coupon(
            &t.admin,
            &bond,
            &0,
            &vec![&t._env, holder.clone()],
            &id,
            &t.client.get_nonce(&t.admin)
        ),
        Err(Ok(BondError::UnknownEquivalence))
    );
    assert!(t.client.get_coupon_calculation(&bond, &0).is_none());
    t.client.publish_equivalence(
        &governance,
        &1,
        &table(&t._env, 100, 80),
        &make_ipfs_hash(&t._env, 2),
        &1,
    );
    assert_eq!(
        t.client.try_distribute_coupon(
            &t.admin,
            &bond,
            &0,
            &vec![&t._env, holder.clone(), holder],
            &id,
            &t.client.get_nonce(&t.admin)
        ),
        Err(Ok(BondError::Overflow))
    );
    assert!(t.client.get_coupon_calculation(&bond, &0).is_none());
    assert_eq!(t.client.get_period_count(&bond), 0);
}

#[test]
fn legacy_and_basket_calculations_record_conversion_without_mixing_credit_types() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let t = deploy(env, admin);
    let project = create_project_id(&t._env, 84);
    let holder = Address::generate(&t._env);
    let bond = issue(&t, &project, &holder, CreditType::Basket);
    let id = report(
        &t,
        &project,
        "gold_standard",
        100_000,
        1000,
        2000,
        BiodiversityMetrics::Present((1, 0, 0)),
    );
    t.client.distribute_coupon(
        &t.admin,
        &bond,
        &0,
        &vec![&t._env, holder.clone()],
        &id,
        &t.client.get_nonce(&t.admin),
    );
    let legacy = t.client.get_coupon_calculation(&bond, &0).unwrap();
    assert_eq!(legacy.table_version, 0);
    assert_eq!(legacy.carbon_pool, 100_000_000);
    assert_eq!(legacy.biodiversity_pool, 1_000_000);
    let governance = provision(&t);
    t.client.publish_equivalence(
        &governance,
        &0,
        &table(&t._env, 100, 50),
        &make_ipfs_hash(&t._env, 1),
        &0,
    );
    let id = report(
        &t,
        &project,
        "gold_standard",
        100_000,
        2000,
        3000,
        BiodiversityMetrics::Present((1, 0, 0)),
    );
    t.client.distribute_coupon(
        &t.admin,
        &bond,
        &1,
        &vec![&t._env, holder],
        &id,
        &t.client.get_nonce(&t.admin),
    );
    let converted = t.client.get_coupon_calculation(&bond, &1).unwrap();
    assert_eq!(converted.carbon_pool, 50_000_000);
    assert_eq!(converted.biodiversity_pool, 1_000_000);
    assert_eq!(t.client.get_coupon_calculation(&bond, &0).unwrap(), legacy);
}

#[test]
fn audit_replays_conversion_discount_true_up_and_covenant_in_the_recorded_order() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let t = deploy(env, admin);
    let governance = provision(&t);
    t.client.publish_equivalence(
        &governance,
        &0,
        &table(&t._env, 100, 80),
        &make_ipfs_hash(&t._env, 1),
        &0,
    );
    let project = create_project_id(&t._env, 85);
    let holder = Address::generate(&t._env);
    let bond = issue(&t, &project, &holder, CreditType::Basket);
    t.client.configure_covenant(
        &t.admin,
        &bond,
        &CovenantConfig {
            min_performance: 100_001,
            min_redemption_funding: 0,
            breach_cycles: 1,
            recovery_cycles: 2,
            stepped_coupon_bps: 5000,
        },
        &t.client.get_nonce(&t.admin),
    );
    t.client.submit_true_up_adjustment(
        &t.admin,
        &bond,
        &0,
        &2_000_000,
        &Symbol::new(&t._env, "audit"),
        &make_ipfs_hash(&t._env, 2),
        &t.client.get_nonce(&t.admin),
    );
    let oracle = nbbs_oracle_consumer::OracleConsumerClient::new(&t._env, &t.oracle_id);
    oracle.set_project_staleness_config(&t.admin, &project, &100, &500, &1000, &0);
    let id = report(
        &t,
        &project,
        "gold_standard",
        100_000,
        1000,
        2000,
        BiodiversityMetrics::Present((1, 0, 0)),
    );
    t._env.ledger().set_timestamp(150);
    let result = t.client.distribute_coupon(
        &t.admin,
        &bond,
        &0,
        &vec![&t._env, holder],
        &id,
        &t.client.get_nonce(&t.admin),
    );
    let audit = t.client.get_coupon_calculation(&bond, &0).unwrap();
    assert_eq!(audit.table_version, 1);
    assert_eq!(audit.normalized_carbon, 80_000);
    assert_eq!(audit.staleness_discount_bps, 1000);
    assert_eq!(audit.true_up_amount, 2_000_000);
    assert_eq!(audit.covenant_bps, 5000);
    let base = t.client.replay_coupon_conversion(&bond, &0) / CREDIT_DIVISOR * CREDIT_MINOR_UNITS;
    let discounted = base * (10_000 - audit.staleness_discount_bps as i128) / 10_000;
    assert_eq!(
        audit.carbon_pool,
        (discounted + audit.true_up_amount) * audit.covenant_bps as i128 / 10_000
    );
    assert_eq!(audit.carbon_pool, 37_000_000);
    assert_eq!(audit.biodiversity_pool, 450_000);
    assert_eq!(result.total_credits, 37_450_000);
}
