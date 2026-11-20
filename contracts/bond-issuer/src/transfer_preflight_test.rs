use super::*;

#[test]
fn preflight_and_transfer_enforce_identical_compliance_balance_and_maturity_checks() {
    let (env, client, admin, seller) = setup();
    let buyer = Address::generate(&env);
    let config = make_config(&env);
    let bond = client.issue_bond(&admin, &config, &0);
    client.subscribe(&seller, &bond, &100, &0);
    for party in [&seller, &buyer] {
        let nonce = client.get_nonce(&admin);
        client.set_transfer_blocked(&admin, party, &true, &nonce);
        assert_eq!(
            client.try_check_transfer(&seller, &buyer, &bond, &10),
            Err(Ok(BondError::Unauthorized))
        );
        assert_eq!(
            client.try_transfer(&seller, &buyer, &bond, &10, &1),
            Err(Ok(BondError::Unauthorized))
        );
        assert_eq!(client.get_nonce(&seller), 1);
        assert_eq!(client.get_holder_balance(&bond, &seller), 100);
        assert_eq!(client.get_holder_balance(&bond, &buyer), 0);
        client.set_transfer_blocked(&admin, party, &false, &(nonce + 1));
    }
    assert_eq!(
        client.try_check_transfer(&seller, &buyer, &bond, &101),
        Err(Ok(BondError::InsufficientSupply))
    );
    client.check_transfer(&seller, &buyer, &bond, &10);
    client.transfer(&seller, &buyer, &bond, &10, &1);
    assert_eq!(client.get_holder_balance(&bond, &buyer), 10);
    env.ledger().set_timestamp(config.maturity_date);
    assert_eq!(
        client.try_check_transfer(&seller, &buyer, &bond, &10),
        Err(Ok(BondError::BondAlreadyMatured))
    );
    assert_eq!(
        client.try_transfer(&seller, &buyer, &bond, &10, &2),
        Err(Ok(BondError::BondAlreadyMatured))
    );
}
