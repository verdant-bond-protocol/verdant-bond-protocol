use super::*;

fn config() -> CovenantConfig {
    CovenantConfig {
        min_performance: 100_000,
        min_redemption_funding: 0,
        breach_cycles: 2,
        recovery_cycles: 2,
        stepped_coupon_bps: 5000,
    }
}

#[test]
fn covenant_breach_recovery_and_boundary_oscillation_apply_actual_coupon_terms() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let t = deploy(env, admin);
    let project = create_project_id(&t._env, 70);
    let holder = Address::generate(&t._env);
    let bond = issue_and_subscribe(&t._env, &t, &project, &holder, 10_000);
    t.client.register_bond(&t.admin, &bond, &project, &0);
    t.client.configure_covenant(&t.admin, &bond, &config(), &1);
    let observations = [99_900, 99_800, 100_000, 99_900, 100_000, 100_100];
    let stepped = [false, true, true, true, true, false];
    for (i, performance) in observations.iter().enumerate() {
        let report = submit_verified_report_with_period(
            &t._env,
            &t,
            &project,
            *performance,
            BiodiversityMetrics::Absent,
            i as u64 * 3,
            1000 + i as u64 * 1000,
            2000 + i as u64 * 1000,
        );
        let result = t.client.distribute_coupon(
            &t.admin,
            &bond,
            &(i as u32),
            &vec![&t._env, holder.clone()],
            &report,
            &(i as u64 + 2),
        );
        let cycle = t.client.get_covenant_cycle(&bond, &(i as u32)).unwrap();
        assert_eq!(cycle.state.stepped_down, stepped[i]);
        assert_eq!(cycle.breached, *performance < 100_000);
        let bps = if stepped[i] { 5000 } else { 10_000 };
        assert_eq!(cycle.coupon_bps, bps);
        assert_eq!(
            result.total_credits,
            (*performance / 1000) * 1_000_000 * bps as i128 / 10_000
        );
    }
    assert!(!t.client.get_covenant_state(&bond).stepped_down);
    assert_eq!(t.client.get_period_count(&bond), 6);
}

#[test]
fn covenant_funding_signal_and_batch_snapshot_prevent_repeated_cycle_counting() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let t = deploy(env, admin);
    let issuer = nbbs_bond_issuer::BondIssuerClient::new(&t._env, &t.issuer_id);
    let project = create_project_id(&t._env, 71);
    let a = Address::generate(&t._env);
    let b = Address::generate(&t._env);
    let bond = issue_and_subscribe(&t._env, &t, &project, &a, 5000);
    issuer.subscribe(&b, &bond, &5000, &0);
    t.client.register_bond(&t.admin, &bond, &project, &0);
    let mut terms = config();
    terms.breach_cycles = 1;
    terms.min_redemption_funding = 100;
    t.client.configure_covenant(&t.admin, &bond, &terms, &1);
    let report = submit_verified_report_with_period(
        &t._env,
        &t,
        &project,
        100_000,
        BiodiversityMetrics::Absent,
        0,
        1000,
        2000,
    );
    let holders = vec![&t._env, a.clone(), b.clone()];
    t.client
        .distribute_coupon_batch(&t.admin, &bond, &0, &holders, &report, &0, &1, &2);
    issuer.fund_redemption(&t.issuer_admin, &bond, &100, &1);
    let original = t.client.get_covenant_cycle(&bond, &0).unwrap();
    t._env.as_contract(&t.client.address, || {
        t._env.storage().persistent().remove(&(
            Symbol::new(&t._env, "TrancheCovenantCycle"),
            bond,
            0u32,
        ));
    });
    t.client
        .distribute_coupon_batch(&t.admin, &bond, &0, &holders, &report, &1, &1, &3);
    assert_eq!(t.client.get_covenant_cycle(&bond, &0).unwrap(), original);
    assert_eq!(t.client.escrowed_credits(&bond, &a), 25_000_000);
    assert_eq!(t.client.escrowed_credits(&bond, &b), 25_000_000);
    for period in 1..=2 {
        let report = submit_verified_report_with_period(
            &t._env,
            &t,
            &project,
            100_000,
            BiodiversityMetrics::Absent,
            period as u64 * 3,
            1000 + period as u64 * 1000,
            2000 + period as u64 * 1000,
        );
        t.client.distribute_coupon(
            &t.admin,
            &bond,
            &period,
            &holders,
            &report,
            &(period as u64 + 3),
        );
        assert_eq!(t.client.get_covenant_state(&bond).stepped_down, period == 1);
    }
}

#[test]
fn covenant_configuration_is_validated_immutable_and_cycles_cannot_skip_or_reuse_reports() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let t = deploy(env, admin);
    let project = create_project_id(&t._env, 72);
    let holder = Address::generate(&t._env);
    let bond = issue_and_subscribe(&t._env, &t, &project, &holder, 10_000);
    t.client.register_bond(&t.admin, &bond, &project, &0);
    let stranger = Address::generate(&t._env);
    assert_eq!(
        t.client
            .try_configure_covenant(&stranger, &bond, &config(), &0),
        Err(Ok(BondError::Unauthorized))
    );
    let mut invalid = config();
    invalid.breach_cycles = 0;
    assert_eq!(
        t.client
            .try_configure_covenant(&t.admin, &bond, &invalid, &1),
        Err(Ok(BondError::InvalidCovenant))
    );
    t.client.configure_covenant(&t.admin, &bond, &config(), &1);
    assert_eq!(
        t.client
            .try_configure_covenant(&t.admin, &bond, &config(), &2),
        Err(Ok(BondError::InvalidCovenant))
    );
    let report = submit_verified_report_with_period(
        &t._env,
        &t,
        &project,
        100_000,
        BiodiversityMetrics::Absent,
        0,
        1000,
        2000,
    );
    let holders = vec![&t._env, holder];
    assert_eq!(
        t.client
            .try_distribute_coupon(&t.admin, &bond, &1, &holders, &report, &2),
        Err(Ok(BondError::InvalidCovenant))
    );
    assert!(t.client.get_covenant_cycle(&bond, &0).is_none());
    t.client
        .distribute_coupon(&t.admin, &bond, &0, &holders, &report, &2);
    assert_eq!(
        t.client
            .try_distribute_coupon(&t.admin, &bond, &1, &holders, &report, &3),
        Err(Ok(BondError::InvalidCovenant))
    );
}
