        #[test]
        fn test_coupon_accounting_invariants() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let bob = Address::generate(&env);
            let charlie = Address::generate(&env);
            let oracle = Address::generate(&env);
            let contracts = deploy_contracts(&env, &admin);

            let project_id = make_project_id(&env, 1);

            let pid = contracts.pr_client.register_project(
                &alice,
                &make_ipfs_hash(&env, 1),
                &Symbol::new(&env, "VCS"),
                &Symbol::new(&env, "US"),
                &0,
            );
            contracts.pr_client.approve_project(&admin, &pid, &0);

            // Bond with 10_000 supply
            let config = make_bond_config(&env, project_id.clone(), 10_000);
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);

            // Subscribe
            contracts.bi_client.subscribe(&bob, &bond_id, &3_000, &0);
            contracts.bi_client.subscribe(&charlie, &bond_id, &6_000, &1); // 9_000 total subscribed out of 10_000

            contracts.oc_client.register_provider(
                &admin,
                &oracle,
                &Symbol::new(&env, "verra_vcs"),
                &0,
            );

            // Report for 100_000 sequestered (100 credits)
            let report_id = contracts.oc_client.submit_report(
                &oracle,
                &project_id,
                &1000u64,
                &2000u64,
                &100_000i128,
                &BiodiversityMetrics::Absent,
                &Symbol::new(&env, "verra_vcs"),
                &make_ipfs_hash(&env, 1),
                &0,
            );
            contracts.oc_client.verify_report(&admin, &report_id, &1);

            contracts.ce_client.register_bond(&admin, &bond_id, &project_id, &0);

            let holders = soroban_sdk::vec![&env, bob.clone(), charlie.clone()];
            let dist_result = contracts.ce_client.distribute_coupon(
                &admin,
                &bond_id,
                &0,
                &holders,
                &report_id,
                &1,
            );

            let total_credits = 100i128; // 100_000 / 1000
            assert_eq!(dist_result.total_credits, total_credits);

            // Calculate expected accruals
            // Since subscribed is 9_000 (bob: 3_000, charlie: 6_000) and bond is 10_000:
            // Formula: amount * 100 / 10000
            // Bob: 3000 * 100 / 10000 = 30 credits
            // Charlie: 6000 * 100 / 10000 = 60 credits
            // Unallocated: 10 credits (plus any dust, here exactly 10)
            
            let bob_accrued = contracts.ce_client.accrued_credits(&bond_id, &bob);
            let charlie_accrued = contracts.ce_client.accrued_credits(&bond_id, &charlie);
            let undistributed = contracts.ce_client.get_undistributed_total(&bond_id);
            
            assert_eq!(bob_accrued, 30);
            assert_eq!(charlie_accrued, 60);
            assert_eq!(undistributed, 10);
            
            // Invariant: Total = Accrued + Undistributed
            assert_eq!(bob_accrued + charlie_accrued + undistributed, total_credits);

            // Bob claims partial (10 credits)
            let credit_hash_1 = make_ipfs_hash(&env, 42);
            let retire_id_1 = contracts.cr_client.retire_credits(
                &bob,
                &bond_id,
                &10,
                &CreditType::Carbon,
                &credit_hash_1,
                &0,
            );
            
            let bob_remaining = contracts.ce_client.accrued_credits(&bond_id, &bob);
            assert_eq!(bob_remaining, 20);
            
            // Duplicate claim attempt / claiming more than accrued
            let credit_hash_2 = make_ipfs_hash(&env, 43);
            let res = contracts.cr_client.try_retire_credits(
                &bob,
                &bond_id,
                &21, // tries to claim 21 but has 20
                &CreditType::Carbon,
                &credit_hash_2,
                &1,
            );
            assert!(res.is_err());
            
            // Admin sweeps
            let swept = contracts.ce_client.sweep_undistributed(&admin, &bond_id, &2);
            assert_eq!(swept, 10);
            assert_eq!(contracts.ce_client.get_undistributed_total(&bond_id), 0);
            
            // Post-sweep claim succeeds for accrued balances
            let retire_id_2 = contracts.cr_client.retire_credits(
                &bob,
                &bond_id,
                &20,
                &CreditType::Carbon,
                &make_ipfs_hash(&env, 44),
                &2,
            );
            assert_eq!(contracts.ce_client.accrued_credits(&bond_id, &bob), 0);
            
            // Final accounting check
            let bob_retired = contracts.cr_client.get_total_retired(&bob);
            assert_eq!(bob_retired, 30);
            let charlie_retired = contracts.cr_client.get_total_retired(&charlie); // 0 since he hasn't claimed yet
            
            let charlie_remaining = contracts.ce_client.accrued_credits(&bond_id, &charlie); // 60
            
            assert_eq!(
                bob_retired + charlie_retired + charlie_remaining + swept + contracts.ce_client.get_undistributed_total(&bond_id),
                total_credits
            );
        }
