use super::*;
use soroban_sdk::testutils::Ledger;

#[test]
fn surge_is_fifo_partial_and_limited_by_cycle_and_actual_pool() {
    let (env, client, admin, first) = setup();
    let second = Address::generate(&env);
    let third = Address::generate(&env);
    let config = make_config(&env);
    let bond = client.issue_bond(&admin, &config, &0);
    client.configure_redemption_budget(&admin, &bond, &2_000, &10, &1);
    client.subscribe(&first, &bond, &5, &0);
    client.subscribe(&second, &bond, &3, &0);
    client.subscribe(&third, &bond, &1, &0);
    env.ledger().set_timestamp(config.maturity_date);
    env.ledger().set_sequence_number(20);
    client.mature_bond(&admin, &bond, &2);
    client.fund_redemption(&admin, &bond, &3_500, &3);
    let key = |v| BytesN::from_array(&env, &[v; 32]);
    let first_id = client.request_redemption(&first, &bond, &5, &key(1), &1);
    let second_id = client.request_redemption(&second, &bond, &3, &key(2), &1);
    env.ledger().set_sequence_number(21);
    let third_id = client.request_redemption(&third, &bond, &1, &key(3), &1);
    assert_eq!((first_id, second_id, third_id), (1, 2, 3));
    assert_eq!(
        client
            .get_redemption_request(&bond, &second_id)
            .submitted_ledger,
        20
    );
    assert_eq!(client.process_redemptions(&bond, &100), 0);
    assert_eq!(client.get_holder_balance(&bond, &first), 3);
    assert_eq!(client.get_holder_balance(&bond, &second), 3);
    assert_eq!(client.get_redemption_pool(&bond), 1_500);
    assert_eq!(client.process_redemptions(&bond, &50), 0);
    assert_eq!(client.get_holder_balance(&bond, &first), 3);
    assert_eq!(
        client.try_redeem(&third, &bond, &1, &2),
        Err(Ok(BondError::RedemptionQueueRequired))
    );
    env.ledger().set_sequence_number(30);
    assert_eq!(client.process_redemptions(&bond, &50), 0);
    assert_eq!(client.get_holder_balance(&bond, &first), 2);
    assert_eq!(client.get_redemption_pool(&bond), 500);
    client.fund_redemption(&admin, &bond, &5_500, &4);
    assert_eq!(client.process_redemptions(&bond, &50), 0);
    assert_eq!(client.get_holder_balance(&bond, &first), 1);
    env.ledger().set_sequence_number(40);
    assert_eq!(client.process_redemptions(&bond, &50), 1);
    assert_eq!(client.get_holder_balance(&bond, &first), 0);
    assert_eq!(client.get_holder_balance(&bond, &second), 2);
    assert_eq!(client.get_holder_balance(&bond, &third), 1);
    env.ledger().set_sequence_number(50);
    assert_eq!(client.process_redemptions(&bond, &50), 1);
    env.ledger().set_sequence_number(60);
    assert_eq!(client.process_redemptions(&bond, &50), 1);
    assert_eq!(client.get_redemption_pool(&bond), 0);
    assert_eq!(client.get_bond_state(&bond).total_subscribed, 0);
    assert_eq!(client.process_redemptions(&bond, &50), 0);
}

#[test]
fn replay_resubmission_and_budget_reset_cannot_jump_queue() {
    let (env, client, admin, holder) = setup();
    let config = make_config(&env);
    let bond = client.issue_bond(&admin, &config, &0);
    client.subscribe(&holder, &bond, &3, &0);
    env.ledger().set_timestamp(config.maturity_date);
    client.mature_bond(&admin, &bond, &1);
    let key = BytesN::from_array(&env, &[8; 32]);
    let id = client.request_redemption(&holder, &bond, &3, &key, &1);
    assert_eq!(client.request_redemption(&holder, &bond, &3, &key, &1), id);
    assert_eq!(client.get_nonce(&holder), 2);
    assert_eq!(
        client.try_request_redemption(&holder, &bond, &2, &key, &2),
        Err(Ok(BondError::DuplicateRedemptionRequest))
    );
    assert_eq!(
        client.try_request_redemption(&holder, &bond, &3, &BytesN::from_array(&env, &[9; 32]), &2),
        Err(Ok(BondError::InsufficientSupply))
    );
    assert_eq!(
        client.try_configure_redemption_budget(&admin, &bond, &9_000, &1, &2),
        Err(Ok(BondError::InvalidRedemptionBudget))
    );
    client.fund_redemption(&admin, &bond, &3_000, &2);
    assert_eq!(client.process_redemptions(&bond, &1), 1);
    assert_eq!(client.request_redemption(&holder, &bond, &3, &key, &99), id);
    assert_eq!(client.get_holder_balance(&bond, &holder), 0);
    assert_eq!(client.get_nonce(&holder), 2);
}

#[test]
fn synchronous_redemption_consumes_the_same_cycle_budget() {
    let (env, client, admin, holder) = setup();
    let config = make_config(&env);
    let bond = client.issue_bond(&admin, &config, &0);
    client.configure_redemption_budget(&admin, &bond, &1_000, &10, &1);
    client.subscribe(&holder, &bond, &2, &0);
    env.ledger().set_timestamp(config.maturity_date);
    client.mature_bond(&admin, &bond, &2);
    client.fund_redemption(&admin, &bond, &2_000, &3);
    client.redeem(&holder, &bond, &1, &1);
    assert_eq!(
        client.try_redeem(&holder, &bond, &1, &1),
        Err(Ok(BondError::InvalidNonce))
    );
    assert_eq!(
        client.try_redeem(&holder, &bond, &1, &2),
        Err(Ok(BondError::RedemptionQueueRequired))
    );
    let id = client.request_redemption(&holder, &bond, &1, &BytesN::from_array(&env, &[1; 32]), &2);
    assert_eq!(client.process_redemptions(&bond, &1), 0);
    env.ledger().set_sequence_number(10);
    assert_eq!(client.process_redemptions(&bond, &1), 1);
    assert_eq!(client.get_redemption_request(&bond, &id).remaining, 0);
}
