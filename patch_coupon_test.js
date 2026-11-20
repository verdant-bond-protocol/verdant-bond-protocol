const fs = require('fs');

let content = fs.readFileSync('contracts/coupon-engine/src/lib.rs', 'utf8');

const tests = `
    #[test]
    fn test_revert_payout() {
        let env = Env::default();
        env.mock_all_auths();
        
        let admin = Address::generate(&env);
        let issuer_id = Address::generate(&env);
        let oracle_id = Address::generate(&env);
        let ce_id = env.register(CouponEngine, (admin.clone(), issuer_id.clone(), oracle_id.clone()));
        let ce_client = CouponEngineClient::new(&env, &ce_id);
        
        let holder = Address::generate(&env);
        let bond_id = 1;
        
        // Setup escrow balance manually (since distribute_coupon is complex to setup)
        env.as_contract(&ce_id, || {
            let key = DataKey::EscrowedCredits(bond_id, holder.clone());
            env.storage().persistent().set(&key, &1000i128);
        });
        
        assert_eq!(ce_client.escrowed_credits(&bond_id, &holder), 1000);
        
        ce_client.revert_payout(&admin, &bond_id, &holder, &500, &0);
        
        assert_eq!(ce_client.escrowed_credits(&bond_id, &holder), 500);
    }
`;

content = content.replace('    #[test]\n    fn test_accrue_credits() {', tests + '\n    #[test]\n    fn test_accrue_credits() {');

fs.writeFileSync('contracts/coupon-engine/src/lib.rs', content);
