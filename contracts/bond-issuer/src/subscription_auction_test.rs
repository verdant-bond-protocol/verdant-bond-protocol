use super::*;
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};

fn auction(
    env: &Env,
    client: &BondIssuerClient,
    admin: &Address,
    supply: i128,
    cap: i128,
) -> (u64, Address, Address) {
    let asset = env.register_stellar_asset_contract_v2(admin.clone());
    asset
        .issuer()
        .set_flag(soroban_sdk::testutils::IssuerFlags::RevocableFlag);
    let token = asset.address();
    let treasury = Address::generate(env);
    let mut config = make_config(env);
    config.total_supply = supply;
    let bond = client.issue_auction(
        admin,
        &config,
        &AuctionConfig {
            token: token.clone(),
            treasury: treasury.clone(),
            open_ledger: 10,
            cutoff_ledger: 20,
            identity_cap: cap,
        },
        &0,
    );
    (bond, token, treasury)
}

fn admit(
    env: &Env,
    client: &BondIssuerClient,
    admin: &Address,
    bond: u64,
    token: &Address,
    identity: u8,
) -> Address {
    let wallet = Address::generate(env);
    client.grant_subscription(
        admin,
        &bond,
        &wallet,
        &BytesN::from_array(env, &[identity; 32]),
        &client.get_nonce(admin),
    );
    StellarAssetClient::new(env, token).mint(&wallet, &100_000);
    wallet
}

#[test]
fn auction_over_exact_and_under_subscription_conserve_capital() {
    for (supply, expected) in [(5, [3, 2]), (8, [4, 4]), (10, [4, 4])] {
        let (env, client, admin, _) = setup();
        let (bond, token, treasury) = auction(&env, &client, &admin, supply, 10);
        let a = admit(&env, &client, &admin, bond, &token, 1);
        let b = admit(&env, &client, &admin, bond, &token, 2);
        env.ledger().set_sequence_number(10);
        // Reverse arrival order cannot win the identity tie.
        client.commit_subscription(&b, &bond, &4, &0);
        client.commit_subscription(&a, &bond, &4, &0);
        env.ledger().set_sequence_number(20);
        let result = client.settle_subscription(&bond);
        assert!(result.settled);
        let balances = TokenClient::new(&env, &token);
        for (wallet, amount) in [(&a, expected[0]), (&b, expected[1])] {
            assert_eq!(client.get_holder_balance(&bond, wallet), amount);
            assert_eq!(balances.balance(wallet), 100_000 - amount * 1000);
            assert_eq!(
                client.get_holder_balance_at_version(&bond, wallet, &1),
                amount
            );
        }
        let total = expected[0] + expected[1];
        assert_eq!(client.total_subscribed(&bond), total);
        assert_eq!(client.total_subscribed_at_version(&bond, &1), total);
        assert_eq!(balances.balance(&treasury), total * 1000);
        assert_eq!(balances.balance(&client.address), 0);
        assert_eq!(
            client.try_settle_subscription(&bond),
            Err(Ok(BondError::AuctionClosed))
        );
        assert_eq!(
            client.try_subscribe(&a, &bond, &1, &1),
            Err(Ok(BondError::AuctionRequired))
        );
    }
}

#[test]
fn auction_shared_identity_cap_and_rounding_resist_wallet_splitting() {
    let (env, client, admin, _) = setup();
    let (bond, token, _) = auction(&env, &client, &admin, 5, 4);
    let a = admit(&env, &client, &admin, bond, &token, 1);
    let split = admit(&env, &client, &admin, bond, &token, 1);
    let b = admit(&env, &client, &admin, bond, &token, 2);
    env.ledger().set_sequence_number(10);
    client.commit_subscription(&a, &bond, &2, &0);
    client.commit_subscription(&split, &bond, &2, &0);
    assert_eq!(
        client.try_commit_subscription(&split, &bond, &1, &1),
        Err(Ok(BondError::IdentityCapExceeded))
    );
    assert_eq!(client.get_nonce(&split), 1);
    client.commit_subscription(&b, &bond, &4, &0);
    env.ledger().set_sequence_number(20);
    let result = client.settle_subscription(&bond);
    assert_eq!(
        client.get_holder_balance(&bond, &a) + client.get_holder_balance(&bond, &split),
        3
    );
    assert_eq!(client.get_holder_balance(&bond, &b), 2);
    let mut first = None;
    for order in result.orders.iter() {
        if order.identity == BytesN::from_array(&env, &[1; 32]) {
            if first.is_none() {
                assert_eq!(order.allocated, 2);
                first = Some(order.wallet);
            } else {
                assert_eq!(order.allocated, 1);
            }
        }
    }
}

#[test]
fn auction_enforces_admission_window_auth_and_maturity_refunds() {
    let (env, client, admin, stranger) = setup();
    let (bond, token, treasury) = auction(&env, &client, &admin, 10, 10);
    let a = admit(&env, &client, &admin, bond, &token, 1);
    assert_eq!(
        client.try_grant_subscription(
            &stranger,
            &bond,
            &stranger,
            &BytesN::from_array(&env, &[2; 32]),
            &0
        ),
        Err(Ok(BondError::Unauthorized))
    );
    assert_eq!(
        client.try_commit_subscription(&a, &bond, &4, &0),
        Err(Ok(BondError::AuctionClosed))
    );
    assert_eq!(
        client.try_settle_subscription(&bond),
        Err(Ok(BondError::AuctionClosed))
    );
    env.ledger().set_sequence_number(10);
    assert_eq!(
        client.try_grant_subscription(
            &admin,
            &bond,
            &stranger,
            &BytesN::from_array(&env, &[2; 32]),
            &2
        ),
        Err(Ok(BondError::AuctionClosed))
    );
    assert_eq!(
        client.try_commit_subscription(&stranger, &bond, &1, &0),
        Err(Ok(BondError::SubscriptionIneligible))
    );
    client.commit_subscription(&a, &bond, &4, &0);
    env.ledger().set_sequence_number(20);
    assert_eq!(
        client.try_commit_subscription(&a, &bond, &1, &1),
        Err(Ok(BondError::AuctionClosed))
    );
    env.ledger().set_timestamp(3_000_000);
    let result = client.settle_subscription(&bond);
    assert_eq!(result.orders.get(0).unwrap().refunded, 4000);
    assert_eq!(TokenClient::new(&env, &token).balance(&a), 100_000);
    assert_eq!(TokenClient::new(&env, &token).balance(&treasury), 0);
    assert_eq!(client.total_subscribed(&bond), 0);
}

#[test]
fn auction_failed_refund_rolls_back_entire_settlement() {
    let (env, client, admin, _) = setup();
    let (bond, token, treasury) = auction(&env, &client, &admin, 5, 10);
    let a = admit(&env, &client, &admin, bond, &token, 1);
    let b = admit(&env, &client, &admin, bond, &token, 2);
    env.ledger().set_sequence_number(10);
    client.commit_subscription(&a, &bond, &4, &0);
    client.commit_subscription(&b, &bond, &4, &0);
    env.ledger().set_sequence_number(20);
    StellarAssetClient::new(&env, &token).set_authorized(&b, &false);
    assert!(client.try_settle_subscription(&bond).is_err());
    assert!(!client.get_subscription(&bond).settled);
    assert_eq!(client.total_subscribed(&bond), 0);
    assert_eq!(client.get_holder_balance(&bond, &a), 0);
    assert_eq!(TokenClient::new(&env, &token).balance(&a), 96_000);
    assert_eq!(TokenClient::new(&env, &token).balance(&treasury), 0);
    StellarAssetClient::new(&env, &token).set_authorized(&b, &true);
    client.settle_subscription(&bond);
}

#[test]
fn apportion_is_exact_bounded_and_reproducible() {
    let env = Env::default();
    env.budget().reset_unlimited();
    for capacity in 0..20 {
        for a in 0..10 {
            for b in 0..10 {
                let requests = vec![&env, a, b];
                let result = subscription_auction::apportion(&env, &requests, capacity).unwrap();
                assert_eq!(
                    result,
                    subscription_auction::apportion(&env, &requests, capacity).unwrap()
                );
                assert_eq!(
                    result.get(0).unwrap() + result.get(1).unwrap(),
                    capacity.min(a + b)
                );
                assert!(result.get(0).unwrap() <= a && result.get(1).unwrap() <= b);
            }
        }
    }
}

#[test]
fn missing_order_book_cannot_reopen_direct_subscription() {
    let (env, client, admin, investor) = setup();
    let (bond, _, _) = auction(&env, &client, &admin, 10, 10);
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .remove(&(Symbol::new(&env, "SubscriptionAuction"), bond));
    });
    assert_eq!(
        client.try_get_subscription(&bond),
        Err(Ok(BondError::InvalidAuction))
    );
    assert_eq!(
        client.try_subscribe(&investor, &bond, &1, &0),
        Err(Ok(BondError::AuctionRequired))
    );
    assert_eq!(
        client.preview_subscribe(&bond, &1).expected_failure,
        Some(BondError::AuctionRequired as u32)
    );
}
