use super::*;
use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};

#[test]
fn every_settlement_precondition_failure_preserves_both_legs() {
    for stage in 0..12 {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let buyer = Address::generate(&env);
        let (issuer_admin, issuer_id, bond, seller) = setup_bond_and_holder(&env, 10_000, 1_000);
        let issuer = nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id);
        let dex_id = env.register(
            DEXRouter,
            (admin.clone(), issuer_id.clone(), Address::generate(&env)),
        );
        let dex = DEXRouterClient::new(&env, &dex_id);
        let asset = Symbol::new(&env, "USDC");
        configure_test_market(&env, &dex, &admin, bond, &asset, 100);
        let id = dex.list_bond_tokens(&seller, &bond, &100, &100, &asset, &4_000_000, &0);
        dex.deposit_quote(&buyer, &asset, &10_000, &0);
        let mut caller = buyer.clone();
        let mut order = id;
        let mut price = 100i128;
        let mut amount = 10i128;
        let mut nonce = 1u64;
        match stage {
            0 => nonce = 9,
            1 => order = 99,
            2 => {
                dex.cancel_listing(&seller, &id, &1);
            }
            3 => {
                caller = seller.clone();
                nonce = 1;
            }
            4 => env.ledger().set_timestamp(4_000_000),
            5 => amount = 0,
            6 => amount = 101,
            7 => price = 99,
            8 => {
                dex.withdraw_quote(&buyer, &asset, &10_000, &1);
                nonce = 2;
            }
            9 => {
                issuer.set_transfer_blocked(&issuer_admin, &buyer, &true, &1);
            }
            10 => {
                issuer.transfer(&seller, &Address::generate(&env), &bond, &1_000, &1);
            }
            11 => env.ledger().set_timestamp(3_000_000),
            _ => unreachable!(),
        }
        let before_order = dex.get_order(&id);
        let before_buyer = dex.get_quote_balance(&buyer, &asset);
        let before_seller = dex.get_quote_balance(&seller, &asset);
        let before_source = issuer.get_holder_balance(&bond, &seller);
        let before_escrow = dex.get_seller_bond_escrow(&seller, &bond);
        let before_nonce = dex.get_nonce(&caller);
        assert!(
            dex.try_execute_purchase(&caller, &order, &price, &amount, &nonce)
                .is_err(),
            "stage {stage}"
        );
        assert_eq!(dex.get_order(&id), before_order, "stage {stage}");
        assert_eq!(dex.get_quote_balance(&buyer, &asset), before_buyer);
        assert_eq!(dex.get_quote_balance(&seller, &asset), before_seller);
        assert_eq!(issuer.get_holder_balance(&bond, &seller), before_source);
        assert_eq!(issuer.get_holder_balance(&bond, &buyer), 0);
        assert_eq!(dex.get_seller_bond_escrow(&seller, &bond), before_escrow);
        assert_eq!(dex.get_nonce(&caller), before_nonce);
        assert!(dex.get_price_observations(&bond, &asset).is_empty());
    }
}

#[test]
fn missing_nested_transfer_authorization_rolls_back_payment_and_order() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let (_, issuer_id, bond, seller) = setup_bond_and_holder(&env, 10_000, 1_000);
    let issuer = nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id);
    let dex_id = env.register(
        DEXRouter,
        (admin.clone(), issuer_id.clone(), Address::generate(&env)),
    );
    let dex = DEXRouterClient::new(&env, &dex_id);
    let asset = Symbol::new(&env, "USDC");
    configure_test_market(&env, &dex, &admin, bond, &asset, 100);
    let order = dex.list_bond_tokens(&seller, &bond, &100, &100, &asset, &3600, &0);
    dex.deposit_quote(&buyer, &asset, &10_000, &0);
    // Root authorization succeeds; intentionally omit the issuer transfer
    // subtree to cause an actual host failure after the quote effects.
    let invoke = MockAuthInvoke {
        contract: &dex_id,
        fn_name: "execute_purchase",
        args: (buyer.clone(), order, 100i128, 10i128, 1u64).into_val(&env),
        sub_invokes: &[],
    };
    env.mock_auths(&[
        MockAuth {
            address: &buyer,
            invoke: &invoke,
        },
        MockAuth {
            address: &seller,
            invoke: &invoke,
        },
    ]);
    assert!(dex
        .try_execute_purchase(&buyer, &order, &100, &10, &1)
        .is_err());
    assert_eq!(dex.get_quote_balance(&buyer, &asset), 10_000);
    assert_eq!(dex.get_quote_balance(&seller, &asset), 0);
    assert_eq!(issuer.get_holder_balance(&bond, &seller), 1_000);
    assert_eq!(issuer.get_holder_balance(&bond, &buyer), 0);
    assert_eq!(dex.get_order(&order).amount, 100);
    assert_eq!(dex.get_nonce(&buyer), 1);
}

#[test]
fn successful_partial_and_final_fill_move_equal_legs_once() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let (_, issuer_id, bond, seller) = setup_bond_and_holder(&env, 10_000, 1_000);
    let issuer = nbbs_bond_issuer::BondIssuerClient::new(&env, &issuer_id);
    let dex_id = env.register(
        DEXRouter,
        (admin.clone(), issuer_id.clone(), Address::generate(&env)),
    );
    let dex = DEXRouterClient::new(&env, &dex_id);
    let asset = Symbol::new(&env, "USDC");
    configure_test_market(&env, &dex, &admin, bond, &asset, 100);
    let order = dex.list_bond_tokens(&seller, &bond, &100, &100, &asset, &3600, &0);
    dex.deposit_quote(&buyer, &asset, &10_000, &0);
    dex.execute_purchase(&buyer, &order, &100, &40, &1);
    assert_eq!(dex.get_order(&order).amount, 60);
    assert_eq!(dex.get_quote_balance(&buyer, &asset), 6_000);
    assert_eq!(dex.get_quote_balance(&seller, &asset), 4_000);
    assert_eq!(issuer.get_holder_balance(&bond, &buyer), 40);
    dex.execute_purchase(&buyer, &order, &100, &60, &2);
    assert_eq!(dex.get_order(&order).amount, 0);
    assert_eq!(dex.get_order(&order).status, OrderStatus::Filled);
    assert_eq!(dex.get_seller_bond_escrow(&seller, &bond), 0);
    assert_eq!(issuer.get_holder_balance(&bond, &buyer), 100);
    assert_eq!(dex.get_quote_balance(&seller, &asset), 10_000);
    assert!(dex
        .try_execute_purchase(&buyer, &order, &100, &1, &3)
        .is_err());
}
