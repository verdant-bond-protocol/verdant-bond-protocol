#[cfg(test)]
mod integration {
    use nbbs_bond_issuer::{BondIssuer, BondIssuerClient};
    use nbbs_coupon_engine::{CouponEngine, CouponEngineClient};
    use nbbs_credit_retirement::{CreditRetirement, CreditRetirementClient};
    use nbbs_dex_router::{DEXRouter, DEXRouterClient};
    use nbbs_oracle_consumer::{OracleConsumer, OracleConsumerClient};
    use nbbs_project_registry::{ProjectRegistry, ProjectRegistryClient};
    use nbbs_shared::{
        BiodiversityMetrics, BondConfig, BondError, CreditType, OracleError, ProjectStatus,
        RegistryError, ReportStatus,
    };
    use soroban_sdk::{
        testutils::Address as _, testutils::Ledger as _, Address, BytesN, Env, Symbol,
    };

    fn make_project_id(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[31] = value;
        BytesN::from_array(env, &arr)
    }

    fn make_ipfs_hash(env: &Env, value: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = value;
        BytesN::from_array(env, &arr)
    }

    fn make_bond_config(env: &Env, project_id: BytesN<32>, total_supply: i128) -> BondConfig {
        BondConfig {
            project_id,
            face_value: 1000,
            coupon_schedule: soroban_sdk::vec![env, 1_000_000u64, 2_000_000u64],
            credit_type: CreditType::Carbon,
            maturity_date: 3_000_000,
            total_supply,
        }
    }

    struct TestContracts<'a> {
        pr_client: ProjectRegistryClient<'a>,
        bi_client: BondIssuerClient<'a>,
        ce_client: CouponEngineClient<'a>,
        oc_client: OracleConsumerClient<'a>,
        dr_client: DEXRouterClient<'a>,
        cr_client: CreditRetirementClient<'a>,
    }

    fn deploy_contracts<'a>(env: &'a Env, admin: &Address) -> TestContracts<'a> {
        let pr_addr = env.register(ProjectRegistry, (admin.clone(),));
        let pr_client = ProjectRegistryClient::new(env, &pr_addr);

        let bi_addr = env.register(BondIssuer, (admin.clone(),));
        let bi_client = BondIssuerClient::new(env, &bi_addr);

        let oc_addr = env.register(OracleConsumer, (admin.clone(),));
        let oc_client = OracleConsumerClient::new(env, &oc_addr);

        let ce_addr = env.register(
            CouponEngine,
            (admin.clone(), bi_addr.clone(), oc_addr.clone()),
        );
        let ce_client = CouponEngineClient::new(env, &ce_addr);

        let dr_addr = env.register(DEXRouter, (admin.clone(), bi_addr.clone(), ce_addr.clone()));
        let dr_client = DEXRouterClient::new(env, &dr_addr);

        let cr_addr = env.register(
            CreditRetirement,
            (admin.clone(), bi_addr.clone(), ce_addr.clone()),
        );
        let cr_client = CreditRetirementClient::new(env, &cr_addr);

        TestContracts {
            pr_client,
            bi_client,
            ce_client,
            oc_client,
            dr_client,
            cr_client,
        }
    }

    /// Verifies a report with two independent signers to satisfy the default
    /// 2-verifier threshold: the admin (consuming `admin_nonce`) plus a
    /// freshly registered, staked provider (consuming `admin_nonce + 1` to
    /// register). The admin's signature alone is not enough to finalize a
    /// report; see "Multi-Source Verification Threshold" in
    /// docs/oracle-design.md.
    fn verify_with_quorum(
        env: &Env,
        oc_client: &OracleConsumerClient,
        admin: &Address,
        report_id: u64,
        admin_nonce: u64,
    ) {
        oc_client.verify_report(admin, &report_id, &admin_nonce);

        let second_verifier = Address::generate(env);
        oc_client.register_provider(
            admin,
            &second_verifier,
            &Symbol::new(env, "satellite"),
            &(admin_nonce + 1),
        );
        oc_client.add_stake(
            &second_verifier,
            &nbbs_oracle_consumer::DEFAULT_MIN_VERIFIER_STAKE,
            &0,
        );
        oc_client.verify_report(&second_verifier, &report_id, &1);
    }

    mod full_lifecycle {
        use super::*;

        #[test]
        fn test_happy_path() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let bob = Address::generate(&env);
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
            assert_eq!(pid, 1);

            contracts.pr_client.approve_project(&admin, &pid, &0);

            let project = contracts.pr_client.get_project(&pid);
            assert_eq!(project.status, ProjectStatus::Approved);

            let config = make_bond_config(&env, project_id.clone(), 10_000);
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);
            assert_eq!(bond_id, 1);

            contracts.bi_client.subscribe(&bob, &bond_id, &1_000, &0);
            let balance = contracts.bi_client.get_holder_balance(&bond_id, &bob);
            assert_eq!(balance, 1_000);

            contracts.oc_client.register_provider(
                &admin,
                &oracle,
                &Symbol::new(&env, "verra_vcs"),
                &0,
            );

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
            assert_eq!(report_id, 1);

            verify_with_quorum(&env, &contracts.oc_client, &admin, report_id, 1);

            let report = contracts.oc_client.get_report(&report_id);
            assert_eq!(report.status, ReportStatus::Verified);

            contracts
                .ce_client
                .register_bond(&admin, &bond_id, &project_id, &0);

            let holders = soroban_sdk::vec![&env, bob.clone()];
            let result = contracts
                .ce_client
                .distribute_coupon(&admin, &bond_id, &0, &holders, &report_id, &1);
            assert!(result.total_credits > 0);
            assert_eq!(result.holder_count, 1);

            let accrued = contracts.ce_client.accrued_credits(&bond_id, &bob);
            assert!(accrued > 0);

            let credit_hash = make_ipfs_hash(&env, 42);
            let retirement_id = contracts.cr_client.retire_credits(
                &bob,
                &bond_id,
                &accrued,
                &CreditType::Carbon,
                &credit_hash,
                &0,
            );
            assert_eq!(retirement_id, 1);

            let record = contracts.cr_client.get_retirement_record(&retirement_id);
            assert_eq!(record.holder, bob);
            assert_eq!(record.amount, accrued);
            assert_eq!(record.credit_type, CreditType::Carbon);
            assert_eq!(record.certificate_ipfs_hash, credit_hash);

            let total_retired = contracts.cr_client.get_total_retired(&bob);
            assert_eq!(total_retired, accrued);

            assert_eq!(contracts.cr_client.total_retirements(), 1);
        }

        #[test]
        fn test_insufficient_supply() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let bob = Address::generate(&env);
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

            let config = make_bond_config(&env, project_id, 1_000);
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);

            contracts.bi_client.subscribe(&alice, &bond_id, &1_000, &0);

            let result = contracts.bi_client.try_subscribe(&bob, &bond_id, &1, &0);
            assert_eq!(result, Err(Ok(BondError::InsufficientSupply)));
        }

        #[test]
        fn test_coupon_requires_verified_report() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let bob = Address::generate(&env);
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

            let config = make_bond_config(&env, project_id.clone(), 10_000);
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);
            contracts.bi_client.subscribe(&bob, &bond_id, &1_000, &0);

            contracts.oc_client.register_provider(
                &admin,
                &oracle,
                &Symbol::new(&env, "verra_vcs"),
                &0,
            );

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

            contracts
                .ce_client
                .register_bond(&admin, &bond_id, &project_id, &0);

            let holders = soroban_sdk::vec![&env, bob.clone()];

            let rejected = contracts
                .ce_client
                .try_distribute_coupon(&admin, &bond_id, &0, &holders, &report_id, &1);
            assert_eq!(rejected, Err(Ok(BondError::ReportNotVerified)));

            verify_with_quorum(&env, &contracts.oc_client, &admin, report_id, 1);

            let result = contracts
                .ce_client
                .distribute_coupon(&admin, &bond_id, &0, &holders, &report_id, &1);
            assert!(result.total_credits > 0);
        }

        #[test]
        fn test_blue_carbon_lifecycle() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let bob = Address::generate(&env);
            let oracle = Address::generate(&env);
            let contracts = deploy_contracts(&env, &admin);

            let project_id = make_project_id(&env, 7);

            let pid = contracts.pr_client.register_project(
                &alice,
                &make_ipfs_hash(&env, 7),
                &Symbol::new(&env, "blue_carbon"),
                &Symbol::new(&env, "US"),
                &0,
            );
            assert_eq!(pid, 1);
            contracts.pr_client.approve_project(&admin, &pid, &0);

            let config = BondConfig {
                project_id: project_id.clone(),
                face_value: 1000,
                coupon_schedule: soroban_sdk::vec![&env, 1_000_000u64, 2_000_000u64],
                credit_type: CreditType::BlueCarbon,
                maturity_date: 3_000_000,
                total_supply: 10_000,
            };
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);
            assert_eq!(bond_id, 1);

            let bond = contracts.bi_client.get_bond(&bond_id);
            assert_eq!(bond.credit_type, CreditType::BlueCarbon);

            contracts.bi_client.subscribe(&bob, &bond_id, &1_000, &0);

            contracts.oc_client.register_provider(
                &admin,
                &oracle,
                &Symbol::new(&env, "blue_carbon"),
                &0,
            );

            let report_id = contracts.oc_client.submit_report(
                &oracle,
                &project_id,
                &1000u64,
                &2000u64,
                &86_000_000i128,
                &BiodiversityMetrics::Absent,
                &Symbol::new(&env, "blue_carbon"),
                &make_ipfs_hash(&env, 7),
                &0,
            );
            assert_eq!(report_id, 1);

            let report = contracts.oc_client.get_report(&report_id);
            assert_eq!(report.methodology, Symbol::new(&env, "blue_carbon"));

            verify_with_quorum(&env, &contracts.oc_client, &admin, report_id, 1);
            assert_eq!(
                contracts.oc_client.get_report(&report_id).status,
                ReportStatus::Verified
            );

            contracts
                .ce_client
                .register_bond(&admin, &bond_id, &project_id, &0);

            let holders = soroban_sdk::vec![&env, bob.clone()];
            let result = contracts
                .ce_client
                .distribute_coupon(&admin, &bond_id, &0, &holders, &report_id, &1);
            assert!(result.total_credits > 0);
            assert_eq!(result.holder_count, 1);

            let accrued = contracts.ce_client.accrued_credits(&bond_id, &bob);
            assert!(accrued > 0);

            let credit_hash = make_ipfs_hash(&env, 42);
            let retirement_id = contracts.cr_client.retire_credits(
                &bob,
                &bond_id,
                &accrued,
                &CreditType::BlueCarbon,
                &credit_hash,
                &0,
            );
            assert_eq!(retirement_id, 1);

            let record = contracts.cr_client.get_retirement_record(&retirement_id);
            assert_eq!(record.holder, bob);
            assert_eq!(record.amount, accrued);
            assert_eq!(record.credit_type, CreditType::BlueCarbon);
        }
    }

    mod oracle {
        use super::*;

        #[test]
        fn test_challenge_flow() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let oracle = Address::generate(&env);
            let challenger = Address::generate(&env);
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

            contracts.oc_client.register_provider(
                &admin,
                &oracle,
                &Symbol::new(&env, "verra_vcs"),
                &0,
            );

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

            contracts.oc_client.challenge_report(
                &challenger,
                &report_id,
                &make_ipfs_hash(&env, 2),
                &0,
            );

            let report = contracts.oc_client.get_report(&report_id);
            assert_eq!(report.status, ReportStatus::Challenged);

            contracts
                .oc_client
                .resolve_challenge(&admin, &report_id, &ReportStatus::Rejected, &1);

            let resolved = contracts.oc_client.get_report(&report_id);
            assert_eq!(resolved.status, ReportStatus::Rejected);
        }

        #[test]
        fn test_multi_source_threshold() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let oracle_a = Address::generate(&env);
            let oracle_b = Address::generate(&env);
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

            contracts
                .oc_client
                .set_signature_threshold(&admin, &2u32, &0);
            contracts.oc_client.register_provider(
                &admin,
                &oracle_a,
                &Symbol::new(&env, "verra_vcs"),
                &1,
            );
            contracts.oc_client.register_provider(
                &admin,
                &oracle_b,
                &Symbol::new(&env, "verra_vcs"),
                &2,
            );
            contracts.oc_client.add_stake(&oracle_a, &100_000i128, &0);
            contracts.oc_client.add_stake(&oracle_b, &100_000i128, &0);

            let report_id = contracts.oc_client.submit_report(
                &oracle_a,
                &project_id,
                &1000u64,
                &2000u64,
                &100_000i128,
                &BiodiversityMetrics::Absent,
                &Symbol::new(&env, "verra_vcs"),
                &make_ipfs_hash(&env, 1),
                &1,
            );

            let self_result = contracts
                .oc_client
                .try_verify_report(&oracle_a, &report_id, &2);
            assert_eq!(self_result, Err(Ok(OracleError::InvalidSignature)));

            contracts.oc_client.verify_report(&admin, &report_id, &3);

            let pending = contracts.oc_client.get_report(&report_id);
            assert_eq!(pending.status, ReportStatus::Pending);
            assert_eq!(contracts.oc_client.get_verification_count(&report_id), 1);

            contracts.oc_client.verify_report(&oracle_b, &report_id, &1);

            let verified = contracts.oc_client.get_report(&report_id);
            assert_eq!(verified.status, ReportStatus::Verified);
            assert_eq!(contracts.oc_client.get_verification_count(&report_id), 2);
        }

        #[test]
        fn test_rejected_challenge_slashes_provider() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let oracle = Address::generate(&env);
            let challenger = Address::generate(&env);
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

            contracts.oc_client.register_provider(
                &admin,
                &oracle,
                &Symbol::new(&env, "verra_vcs"),
                &0,
            );
            contracts.oc_client.add_stake(&oracle, &100_000i128, &0);

            let report_id = contracts.oc_client.submit_report(
                &oracle,
                &project_id,
                &1000u64,
                &2000u64,
                &100_000i128,
                &BiodiversityMetrics::Absent,
                &Symbol::new(&env, "verra_vcs"),
                &make_ipfs_hash(&env, 1),
                &1,
            );

            contracts.oc_client.challenge_report(
                &challenger,
                &report_id,
                &make_ipfs_hash(&env, 2),
                &0,
            );

            contracts
                .oc_client
                .resolve_challenge(&admin, &report_id, &ReportStatus::Rejected, &1);

            let provider = contracts.oc_client.get_provider(&oracle);
            assert_eq!(provider.stake, 90_000);
            assert!(provider.active);

            let report = contracts.oc_client.get_report(&report_id);
            assert_eq!(report.status, ReportStatus::Rejected);
        }
    }

    mod challenge_coupon_escrow {
        use super::*;

        #[test]
        fn test_coupon_distribution_blocked_during_active_challenge() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let bob = Address::generate(&env);
            let oracle = Address::generate(&env);
            let challenger = Address::generate(&env);
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

            let config = make_bond_config(&env, project_id.clone(), 10_000);
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);
            contracts.bi_client.subscribe(&bob, &bond_id, &1_000, &0);

            contracts.oc_client.register_provider(
                &admin,
                &oracle,
                &Symbol::new(&env, "verra_vcs"),
                &0,
            );
            contracts
                .oc_client
                .set_signature_threshold(&admin, &1u32, &1);
            contracts.oc_client.add_stake(&oracle, &100_000i128, &0);

            let report_id = contracts.oc_client.submit_report(
                &oracle,
                &project_id,
                &1000u64,
                &2000u64,
                &100_000i128,
                &BiodiversityMetrics::Absent,
                &Symbol::new(&env, "verra_vcs"),
                &make_ipfs_hash(&env, 1),
                &1,
            );

            contracts.oc_client.verify_report(&admin, &report_id, &2);
            assert_eq!(
                contracts.oc_client.get_report(&report_id).status,
                ReportStatus::Verified
            );

            contracts
                .ce_client
                .register_bond(&admin, &bond_id, &project_id, &0);

            let holders = soroban_sdk::vec![&env, bob.clone()];

            let ok = contracts
                .ce_client
                .distribute_coupon(&admin, &bond_id, &0, &holders, &report_id, &1);
            assert!(ok.total_credits > 0);

            contracts.oc_client.challenge_report(
                &challenger,
                &report_id,
                &make_ipfs_hash(&env, 2),
                &0,
            );
            assert_eq!(
                contracts.oc_client.get_report(&report_id).status,
                ReportStatus::Challenged
            );

            let blocked = contracts
                .ce_client
                .try_distribute_coupon(&admin, &bond_id, &1, &holders, &report_id, &2);
            assert_eq!(blocked, Err(Ok(BondError::ReportNotVerified)));

            contracts
                .oc_client
                .resolve_challenge(&admin, &report_id, &ReportStatus::Verified, &3);
            assert_eq!(
                contracts.oc_client.get_report(&report_id).status,
                ReportStatus::Verified
            );

            let retry = contracts
                .ce_client
                .distribute_coupon(&admin, &bond_id, &1, &holders, &report_id, &2);
            assert!(retry.total_credits > 0);

            let provider = contracts.oc_client.get_provider(&oracle);
            assert_eq!(provider.stake, 100_000);
            assert!(provider.active);
        }
    }

    mod dex {
        use super::*;

        #[test]
        fn test_full_settlement_with_seller_withdrawal() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let bob = Address::generate(&env);
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

            let config = make_bond_config(&env, project_id, 10_000);
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);
            contracts.bi_client.subscribe(&alice, &bond_id, &5_000, &0);

            let order_id = contracts.dr_client.list_bond_tokens(
                &alice,
                &bond_id,
                &1_000i128,
                &100i128,
                &Symbol::new(&env, "USDC"),
                &3600u64,
                &0,
            );

            contracts
                .dr_client
                .deposit_quote(&bob, &Symbol::new(&env, "USDC"), &100_000i128, &0);

            contracts
                .dr_client
                .execute_purchase(&bob, &order_id, &100i128, &1_000i128, &1);

            let order = contracts.dr_client.get_order(&order_id);
            assert_eq!(order.status, nbbs_dex_router::OrderStatus::Filled);

            assert_eq!(
                contracts
                    .dr_client
                    .get_quote_balance(&alice, &Symbol::new(&env, "USDC")),
                100_000
            );
            assert_eq!(
                contracts
                    .dr_client
                    .get_quote_balance(&bob, &Symbol::new(&env, "USDC")),
                0
            );

            contracts.dr_client.withdraw_quote(
                &alice,
                &Symbol::new(&env, "USDC"),
                &100_000i128,
                &1,
            );

            assert_eq!(
                contracts
                    .dr_client
                    .get_quote_balance(&alice, &Symbol::new(&env, "USDC")),
                0
            );
        }

        #[test]
        fn test_order_full_fill() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let bob = Address::generate(&env);
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

            let config = make_bond_config(&env, project_id, 10_000);
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);
            contracts.bi_client.subscribe(&alice, &bond_id, &5_000, &0);

            let order_id = contracts.dr_client.list_bond_tokens(
                &alice,
                &bond_id,
                &1_000i128,
                &100i128,
                &Symbol::new(&env, "USDC"),
                &3600u64,
                &0,
            );
            assert_eq!(order_id, 1);

            contracts
                .dr_client
                .deposit_quote(&bob, &Symbol::new(&env, "USDC"), &100_000i128, &0);

            contracts
                .dr_client
                .execute_purchase(&bob, &order_id, &100i128, &1_000i128, &1);

            let order = contracts.dr_client.get_order(&order_id);
            assert_eq!(order.status, nbbs_dex_router::OrderStatus::Filled);
        }

        #[test]
        fn test_order_partial_fill() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let bob = Address::generate(&env);
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

            let config = make_bond_config(&env, project_id, 10_000);
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);
            contracts.bi_client.subscribe(&alice, &bond_id, &5_000, &0);

            let order_id = contracts.dr_client.list_bond_tokens(
                &alice,
                &bond_id,
                &1_000i128,
                &100i128,
                &Symbol::new(&env, "USDC"),
                &3600u64,
                &0,
            );

            contracts
                .dr_client
                .deposit_quote(&bob, &Symbol::new(&env, "USDC"), &100_000i128, &0);

            contracts
                .dr_client
                .execute_purchase(&bob, &order_id, &100i128, &400i128, &1);

            let order = contracts.dr_client.get_order(&order_id);
            assert_eq!(order.status, nbbs_dex_router::OrderStatus::PartiallyFilled);
            assert_eq!(order.amount, 600);

            contracts
                .dr_client
                .execute_purchase(&bob, &order_id, &100i128, &600i128, &2);

            let order = contracts.dr_client.get_order(&order_id);
            assert_eq!(order.status, nbbs_dex_router::OrderStatus::Filled);
        }

        #[test]
        fn test_order_settles_bond_tokens() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let bob = Address::generate(&env);
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

            let config = make_bond_config(&env, project_id, 10_000);
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);
            contracts.bi_client.subscribe(&alice, &bond_id, &5_000, &0);

            let order_id = contracts.dr_client.list_bond_tokens(
                &alice,
                &bond_id,
                &1_000i128,
                &100i128,
                &Symbol::new(&env, "USDC"),
                &3600u64,
                &0,
            );

            contracts
                .dr_client
                .deposit_quote(&bob, &Symbol::new(&env, "USDC"), &100_000i128, &0);

            contracts
                .dr_client
                .execute_purchase(&bob, &order_id, &100i128, &1_000i128, &1);

            let order = contracts.dr_client.get_order(&order_id);
            assert_eq!(order.status, nbbs_dex_router::OrderStatus::Filled);

            let alice_balance = contracts.bi_client.get_holder_balance(&bond_id, &alice);
            let bob_balance = contracts.bi_client.get_holder_balance(&bond_id, &bob);
            assert_eq!(alice_balance, 4_000);
            assert_eq!(bob_balance, 1_000);

            assert_eq!(
                contracts
                    .dr_client
                    .get_quote_balance(&alice, &Symbol::new(&env, "USDC")),
                100_000
            );
            assert_eq!(
                contracts
                    .dr_client
                    .get_quote_balance(&bob, &Symbol::new(&env, "USDC")),
                0
            );
        }
    }

    mod security {
        use super::*;

        #[test]
        fn test_time_based_maturity_and_redeem() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
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

            let config = make_bond_config(&env, project_id, 10_000);
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);
            contracts.bi_client.subscribe(&alice, &bond_id, &2_000, &0);

            env.ledger().set_timestamp(config.maturity_date - 1);
            let early = contracts.bi_client.try_mature_bond(&admin, &bond_id, &1);
            assert_eq!(early, Err(Ok(BondError::Overflow)));

            env.ledger().set_timestamp(config.maturity_date);
            contracts.bi_client.mature_bond(&admin, &bond_id, &1);
            contracts
                .bi_client
                .fund_redemption(&admin, &bond_id, &2_000_000, &2);

            let state = contracts.bi_client.get_bond_state(&bond_id);
            assert_eq!(state.status, nbbs_shared::BondStatus::Matured);

            contracts.bi_client.redeem(&alice, &bond_id, &2_000, &1);
            assert_eq!(contracts.bi_client.get_holder_balance(&bond_id, &alice), 0);
        }

        #[test]
        fn test_coupon_dust_reconciliation() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let bob = Address::generate(&env);
            let carol = Address::generate(&env);
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

            let config = make_bond_config(&env, project_id.clone(), 10_000);
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);

            contracts.bi_client.subscribe(&alice, &bond_id, &1, &0);
            contracts.bi_client.subscribe(&bob, &bond_id, &1, &0);
            contracts.bi_client.subscribe(&carol, &bond_id, &1, &0);

            contracts.oc_client.register_provider(
                &admin,
                &oracle,
                &Symbol::new(&env, "verra_vcs"),
                &0,
            );

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
            verify_with_quorum(&env, &contracts.oc_client, &admin, report_id, 1);

            contracts
                .ce_client
                .register_bond(&admin, &bond_id, &project_id, &0);

            let holders = soroban_sdk::vec![&env, alice.clone(), bob.clone(), carol.clone(),];
            let result = contracts
                .ce_client
                .distribute_coupon(&admin, &bond_id, &0, &holders, &report_id, &1);

            let total = 100 * nbbs_coupon_engine::CREDIT_MINOR_UNITS;
            let credits_per_token = total * nbbs_coupon_engine::FIXED_POINT / 3;
            // each holder holds 1 token
            let per_holder = credits_per_token / nbbs_coupon_engine::FIXED_POINT;
            let distributed = per_holder * 3;

            assert_eq!(result.total_credits, distributed);
            assert_eq!(result.holder_count, 3);

            assert_eq!(
                contracts.ce_client.get_undistributed_total(&bond_id),
                total - distributed
            );

            let swept = contracts
                .ce_client
                .sweep_undistributed(&admin, &bond_id, &2);
            assert_eq!(swept, total - distributed);
            assert_eq!(contracts.ce_client.get_undistributed_total(&bond_id), 0);
        }

        #[test]
        fn test_nonce_replay() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let contracts = deploy_contracts(&env, &admin);

            contracts.pr_client.register_project(
                &alice,
                &make_ipfs_hash(&env, 1),
                &Symbol::new(&env, "VCS"),
                &Symbol::new(&env, "US"),
                &0,
            );

            let result = contracts.pr_client.try_register_project(
                &alice,
                &make_ipfs_hash(&env, 2),
                &Symbol::new(&env, "GS"),
                &Symbol::new(&env, "BR"),
                &0,
            );
            assert_eq!(result, Err(Ok(RegistryError::InvalidNonce)));

            let id = contracts.pr_client.register_project(
                &alice,
                &make_ipfs_hash(&env, 2),
                &Symbol::new(&env, "GS"),
                &Symbol::new(&env, "BR"),
                &1,
            );
            assert_eq!(id, 2);
        }

        #[test]
        fn test_permission_checks() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let bob = Address::generate(&env);
            let _oracle = Address::generate(&env);
            let contracts = deploy_contracts(&env, &admin);

            let project_id = make_project_id(&env, 1);

            let pid = contracts.pr_client.register_project(
                &alice,
                &make_ipfs_hash(&env, 1),
                &Symbol::new(&env, "VCS"),
                &Symbol::new(&env, "US"),
                &0,
            );

            let result = contracts.pr_client.try_approve_project(&bob, &pid, &0);
            assert_eq!(result, Err(Ok(RegistryError::Unauthorized)));

            let config = make_bond_config(&env, project_id.clone(), 10_000);
            let result = contracts.bi_client.try_issue_bond(&alice, &config, &0);
            assert_eq!(result, Err(Ok(BondError::Unauthorized)));

            let result = contracts.oc_client.try_submit_report(
                &bob,
                &project_id,
                &1000u64,
                &2000u64,
                &100_000i128,
                &BiodiversityMetrics::Absent,
                &Symbol::new(&env, "verra_vcs"),
                &make_ipfs_hash(&env, 1),
                &0,
            );
            assert_eq!(result, Err(Ok(OracleError::ProviderNotFound)));
        }

        #[test]
        fn test_unauthorized_oracle_operations() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let alice = Address::generate(&env);
            let rogue = Address::generate(&env);
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

            let result = contracts.oc_client.try_submit_report(
                &rogue,
                &project_id,
                &1000u64,
                &2000u64,
                &100_000i128,
                &BiodiversityMetrics::Absent,
                &Symbol::new(&env, "verra_vcs"),
                &make_ipfs_hash(&env, 1),
                &0,
            );
            assert_eq!(result, Err(Ok(OracleError::ProviderNotFound)));
        }
    }

    mod claimable_provenance {
        use super::*;

        // Itemized claimable-credit provenance (#156): a Basket bond accrues
        // Carbon and Biodiversity credits per period and the itemized view joins
        // each line with its report id and period window. Claiming clears all
        // lines.
        #[test]
        fn test_itemized_claimable_details_across_periods() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let holder = Address::generate(&env);
            let oracle = Address::generate(&env);
            let contracts = deploy_contracts(&env, &admin);

            let project_id = make_project_id(&env, 1);
            let pid = contracts.pr_client.register_project(
                &holder,
                &make_ipfs_hash(&env, 1),
                &Symbol::new(&env, "VCS"),
                &Symbol::new(&env, "US"),
                &0,
            );
            contracts.pr_client.approve_project(&admin, &pid, &0);

            let mut config = make_bond_config(&env, project_id.clone(), 10_000);
            config.credit_type = CreditType::Basket;
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);
            contracts
                .bi_client
                .subscribe(&holder, &bond_id, &10_000, &0);

            contracts.oc_client.register_provider(
                &admin,
                &oracle,
                &Symbol::new(&env, "verra_vcs"),
                &0,
            );

            let report_0 = contracts.oc_client.submit_report(
                &oracle,
                &project_id,
                &1000u64,
                &2000u64,
                &100_000i128,
                &BiodiversityMetrics::Present((500, 125, 1_000)),
                &Symbol::new(&env, "verra_vcs"),
                &make_ipfs_hash(&env, 1),
                &0,
            );
            verify_with_quorum(&env, &contracts.oc_client, &admin, report_0, 1);

            let carbon_0 = 100 * nbbs_coupon_engine::CREDIT_MINOR_UNITS;
            let bio_0 = (500 * nbbs_coupon_engine::HABITAT_CREDIT_RATE
                + 125 * nbbs_coupon_engine::SPECIES_CREDIT_RATE
                + 1_000 * nbbs_coupon_engine::UNIT_CREDIT_RATE)
                * nbbs_coupon_engine::CREDIT_MINOR_UNITS
                / nbbs_coupon_engine::HABITAT_CREDIT_RATE;

            contracts
                .ce_client
                .register_bond(&admin, &bond_id, &project_id, &0);
            let holders = soroban_sdk::vec![&env, holder.clone()];
            contracts
                .ce_client
                .distribute_coupon(&admin, &bond_id, &0, &holders, &report_0, &1);

            let report_1 = contracts.oc_client.submit_report(
                &oracle,
                &project_id,
                &2001u64,
                &3000u64,
                &50_000i128,
                &BiodiversityMetrics::Present((200, 50, 300)),
                &Symbol::new(&env, "verra_vcs"),
                &make_ipfs_hash(&env, 1),
                &1,
            );
            verify_with_quorum(&env, &contracts.oc_client, &admin, report_1, 3);

            let carbon_1 = 50 * nbbs_coupon_engine::CREDIT_MINOR_UNITS;
            let bio_1 = (200 * nbbs_coupon_engine::HABITAT_CREDIT_RATE
                + 50 * nbbs_coupon_engine::SPECIES_CREDIT_RATE
                + 300 * nbbs_coupon_engine::UNIT_CREDIT_RATE)
                * nbbs_coupon_engine::CREDIT_MINOR_UNITS
                / nbbs_coupon_engine::HABITAT_CREDIT_RATE;

            let holder_vec = soroban_sdk::vec![&env, holder.clone()];
            contracts
                .ce_client
                .distribute_coupon(&admin, &bond_id, &1, &holder_vec, &report_1, &2);

            let expected_total = carbon_0 + bio_0 + carbon_1 + bio_1;
            assert_eq!(
                contracts.ce_client.claimable_credits(&bond_id, &holder),
                expected_total
            );

            let details = contracts
                .ce_client
                .claimable_credit_details(&bond_id, &holder);
            assert_eq!(details.len(), 4);

            let line = details.get(0).unwrap();
            assert_eq!(line.period_index, 0);
            assert_eq!(line.report_id, report_0);
            assert_eq!(line.start_time, 1000);
            assert_eq!(line.end_time, 2000);
            assert_eq!(line.credit_type, CreditType::Carbon);
            assert_eq!(line.amount, carbon_0);

            let line = details.get(1).unwrap();
            assert_eq!(line.period_index, 0);
            assert_eq!(line.report_id, report_0);
            assert_eq!(line.credit_type, CreditType::Biodiversity);
            assert_eq!(line.amount, bio_0);

            let line = details.get(2).unwrap();
            assert_eq!(line.period_index, 1);
            assert_eq!(line.report_id, report_1);
            assert_eq!(line.start_time, 2001);
            assert_eq!(line.end_time, 3000);
            assert_eq!(line.credit_type, CreditType::Carbon);
            assert_eq!(line.amount, carbon_1);

            let line = details.get(3).unwrap();
            assert_eq!(line.period_index, 1);
            assert_eq!(line.report_id, report_1);
            assert_eq!(line.credit_type, CreditType::Biodiversity);
            assert_eq!(line.amount, bio_1);

            let claimed = contracts.ce_client.claim_credits(&holder, &bond_id, &0);
            assert_eq!(claimed, expected_total);
            assert_eq!(contracts.ce_client.claimable_credits(&bond_id, &holder), 0);
            assert_eq!(
                contracts
                    .ce_client
                    .claimable_credit_details(&bond_id, &holder)
                    .len(),
                0
            );
        }

        #[test]
        fn test_claimable_details_empty_before_distribution() {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();

            let admin = Address::generate(&env);
            let holder = Address::generate(&env);
            let contracts = deploy_contracts(&env, &admin);

            let project_id = make_project_id(&env, 1);
            let config = make_bond_config(&env, project_id, 10_000);
            let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);

            assert_eq!(contracts.ce_client.claimable_credits(&bond_id, &holder), 0);
            assert_eq!(
                contracts
                    .ce_client
                    .claimable_credit_details(&bond_id, &holder)
                    .len(),
                0
            );
        }
    }

    mod governance {
        use super::*;
        use nbbs_governance::{Governance, GovernanceClient, DEFAULT_TIMELOCK_SECONDS};
        use soroban_sdk::IntoVal;

        // Role granting is governance-gated exactly when each contract's admin
        // is the governance contract. This walks that configuration for every
        // admin-bearing contract: hand the role to governance, then rotate it
        // again only through a threshold-approved, timelocked proposal. It also
        // pins the calling convention `execute` relies on: every admin method
        // takes the caller first and a nonce last, `set_admin` included.
        #[test]
        fn test_governance_rotates_admin_on_every_contract() {
            let env = Env::default();
            env.mock_all_auths();
            let admin = Address::generate(&env);
            let contracts = deploy_contracts(&env, &admin);

            let signers = soroban_sdk::vec![
                &env,
                Address::generate(&env),
                Address::generate(&env),
                Address::generate(&env)
            ];
            let threshold: u32 = 2;
            let gov_addr = env.register(
                Governance,
                (&signers, &threshold, &DEFAULT_TIMELOCK_SECONDS),
            );
            let gov = GovernanceClient::new(&env, &gov_addr);
            let method = Symbol::new(&env, "set_admin");
            let proposer = signers.get(0).unwrap();
            let voter = signers.get(1).unwrap();
            let allower = signers.get(2).unwrap();

            // Every contract's admin nonce is independent, so each hand-over is
            // that admin's first call on that contract.
            contracts.pr_client.set_admin(&admin, &gov_addr);
            contracts.bi_client.set_admin(&admin, &gov_addr);
            contracts.oc_client.set_admin(&admin, &gov_addr);
            contracts.ce_client.set_admin(&admin, &gov_addr);
            contracts.dr_client.set_admin(&admin, &gov_addr);
            contracts.cr_client.set_admin(&admin, &gov_addr);

            let targets = [
                contracts.pr_client.address.clone(),
                contracts.bi_client.address.clone(),
                contracts.oc_client.address.clone(),
                contracts.ce_client.address.clone(),
                contracts.dr_client.address.clone(),
                contracts.cr_client.address.clone(),
            ];
            let new_admin = Address::generate(&env);
            let mut now = 0u64;
            for (i, target) in targets.iter().enumerate() {
                let i = i as u64;
                gov.add_to_allow_list(&allower, target, &method, &(2 * i));
                let proposal_id = gov.propose(
                    &proposer,
                    target,
                    &method,
                    &soroban_sdk::vec![&env, new_admin.clone().into_val(&env)],
                    &Symbol::new(&env, "rotate"),
                    &(2 * i),
                );
                gov.vote_approve(&voter, &proposal_id, &i);
                // One vote short of the threshold: nothing may execute yet.
                assert!(gov
                    .try_execute(&proposer, &proposal_id, &(2 * i + 1))
                    .is_err());
                gov.vote_approve(&allower, &proposal_id, &(2 * i + 1));
                // Queued, but the timelock has not elapsed.
                assert!(gov
                    .try_execute(&proposer, &proposal_id, &(2 * i + 1))
                    .is_err());

                now += DEFAULT_TIMELOCK_SECONDS;
                env.ledger().set_timestamp(now);
                gov.execute(&proposer, &proposal_id, &(2 * i + 1));
            }

            assert_eq!(contracts.pr_client.get_admin(), new_admin);
            assert_eq!(contracts.bi_client.get_admin(), new_admin);
            assert_eq!(contracts.oc_client.get_admin(), new_admin);
            assert_eq!(contracts.ce_client.get_admin(), new_admin);
            assert_eq!(contracts.dr_client.get_admin(), new_admin);
            assert_eq!(contracts.cr_client.get_admin(), new_admin);

            // Neither the original key nor governance itself holds the role now.
            assert!(contracts
                .bi_client
                .try_set_admin(&admin, &Address::generate(&env), &1)
                .is_err());
            assert!(contracts
                .bi_client
                .try_set_admin(&gov_addr, &Address::generate(&env), &1)
                .is_err());
        }
    }

    mod property {
        use super::*;
        use proptest::prelude::*;

        fn setup_project_and_bond(
            env: &Env,
            contracts: &TestContracts,
            admin: &Address,
            alice: &Address,
            supply: i128,
        ) -> (BytesN<32>, u64) {
            let project_id = make_project_id(env, 1);
            let pid = contracts.pr_client.register_project(
                alice,
                &make_ipfs_hash(env, 1),
                &Symbol::new(env, "VCS"),
                &Symbol::new(env, "US"),
                &0,
            );
            contracts.pr_client.approve_project(admin, &pid, &0);
            let config = make_bond_config(env, project_id.clone(), supply);
            let bond_id = contracts.bi_client.issue_bond(admin, &config, &0);
            (project_id, bond_id)
        }

        proptest! {
            #![proptest_config(ProptestConfig {
                cases: 64,
                ..ProptestConfig::default()
            })]

            // Cross-contract DEX settlement conserves the quote ledger and the
            // bond supply: a fill creates or destroys neither quote nor bonds.
            #[test]
            fn dex_settlement_conserves_value(
                order_amount in 1i128..50_000i128,
                price in 1i128..10_000i128,
                fill in 1i128..50_000i128,
            ) {
                let env = Env::default();
                env.mock_all_auths_allowing_non_root_auth();
                let admin = Address::generate(&env);
                let alice = Address::generate(&env);
                let bob = Address::generate(&env);
                let contracts = deploy_contracts(&env, &admin);

                let (_project_id, bond_id) =
                    setup_project_and_bond(&env, &contracts, &admin, &alice, 1_000_000);

                contracts
                    .bi_client
                    .subscribe(&alice, &bond_id, &order_amount, &0);

                let quote = Symbol::new(&env, "USDC");
                let order_id = contracts.dr_client.list_bond_tokens(
                    &alice,
                    &bond_id,
                    &order_amount,
                    &price,
                    &quote,
                    &3600u64,
                    &0,
                );

                let deposit = order_amount * price;
                contracts
                    .dr_client
                    .deposit_quote(&bob, &quote, &deposit, &0);

                let first = fill.min(order_amount);
                contracts
                    .dr_client
                    .execute_purchase(&bob, &order_id, &price, &first, &1);
                if first < order_amount {
                    contracts.dr_client.execute_purchase(
                        &bob,
                        &order_id,
                        &price,
                        &(order_amount - first),
                        &2,
                    );
                }

                let order = contracts.dr_client.get_order(&order_id);
                prop_assert_eq!(order.status, nbbs_dex_router::OrderStatus::Filled);

                prop_assert_eq!(
                    contracts.dr_client.get_quote_balance(&bob, &quote),
                    0
                );
                prop_assert_eq!(
                    contracts.dr_client.get_quote_balance(&alice, &quote),
                    deposit
                );
                prop_assert_eq!(
                    contracts.dr_client.get_quote_balance(&alice, &quote)
                        + contracts.dr_client.get_quote_balance(&bob, &quote),
                    deposit
                );

                let alice_bond = contracts.bi_client.get_holder_balance(&bond_id, &alice);
                let bob_bond = contracts.bi_client.get_holder_balance(&bond_id, &bob);
                prop_assert_eq!(alice_bond + bob_bond, order_amount);
                prop_assert_eq!(bob_bond, order_amount);
                prop_assert_eq!(
                    contracts.bi_client.total_subscribed(&bond_id),
                    order_amount
                );
            }

            // Cross-contract coupon distribution conserves credits: the sum of
            // holder accrued credits plus the undistributed pool equals the total
            // credits, and a sweep recovers the remainder in full.
            #[test]
            fn coupon_distribution_conserves_credits(
                carbon in 0i128..1_000_000_000i128,
                balances in proptest::collection::vec(1i128..10_000i128, 1..4),
            ) {
                let env = Env::default();
                env.mock_all_auths_allowing_non_root_auth();
                let admin = Address::generate(&env);
                let alice = Address::generate(&env);
                let oracle = Address::generate(&env);
                let contracts = deploy_contracts(&env, &admin);

                let total_subscribed: i128 = balances.iter().sum();
                let project_id = make_project_id(&env, 1);
                let pid = contracts.pr_client.register_project(
                    &alice,
                    &make_ipfs_hash(&env, 1),
                    &Symbol::new(&env, "VCS"),
                    &Symbol::new(&env, "US"),
                    &0,
                );
                contracts.pr_client.approve_project(&admin, &pid, &0);

                let config = make_bond_config(&env, project_id.clone(), total_subscribed);
                let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);

                let holders: std::vec::Vec<Address> = balances
                    .iter()
                    .map(|_| Address::generate(&env))
                    .collect();
                for (holder, &amount) in holders.iter().zip(balances.iter()) {
                    contracts.bi_client.subscribe(holder, &bond_id, &amount, &0);
                }

                contracts.oc_client.register_provider(
                    &admin,
                    &oracle,
                    &Symbol::new(&env, "verra_vcs"),
                    &0,
                );
                let report_id = contracts.oc_client.submit_report(
                    &oracle,
                    &project_id,
                    &1000u64,
                    &2000u64,
                    &carbon,
                    &BiodiversityMetrics::Absent,
                    &Symbol::new(&env, "verra_vcs"),
                    &make_ipfs_hash(&env, 1),
                    &0,
                );
                verify_with_quorum(&env, &contracts.oc_client, &admin, report_id, 1);

                contracts.ce_client.register_bond(&admin, &bond_id, &project_id, &0);

                let mut holder_vec = soroban_sdk::Vec::new(&env);
                for h in &holders {
                    holder_vec.push_back(h.clone());
                }

                let total_credits =
                    carbon / nbbs_coupon_engine::CREDIT_DIVISOR * nbbs_coupon_engine::CREDIT_MINOR_UNITS;
                contracts.ce_client.distribute_coupon(
                    &admin,
                    &bond_id,
                    &0,
                    &holder_vec,
                    &report_id,
                    &1,
                );

                let mut distributed = 0i128;
                for (holder, &amount) in holders.iter().zip(balances.iter()) {
                    let cpt = if total_credits > 0 {
                        total_credits * nbbs_coupon_engine::FIXED_POINT / total_subscribed
                    } else {
                        0
                    };
                    let expected = cpt * amount / nbbs_coupon_engine::FIXED_POINT;
                    let accrued = contracts.ce_client.accrued_credits(&bond_id, holder);
                    prop_assert_eq!(accrued, expected);
                    distributed += expected;
                }
                let undistributed = total_credits.saturating_sub(distributed);
                prop_assert_eq!(
                    contracts.ce_client.get_undistributed_total(&bond_id),
                    undistributed
                );
                prop_assert_eq!(distributed + undistributed, total_credits);

                let swept = contracts.ce_client.sweep_undistributed(&admin, &bond_id, &2);
                prop_assert_eq!(swept, undistributed);
                prop_assert_eq!(contracts.ce_client.get_undistributed_total(&bond_id), 0);
            }

            // Cross-contract slashing never drives a provider's stake negative and
            // deactivates the provider exactly when the stake reaches zero.
            #[test]
            fn cross_contract_slash_conserves_stake(stake in 1i128..1_000_000i128) {
                let env = Env::default();
                env.mock_all_auths_allowing_non_root_auth();
                let admin = Address::generate(&env);
                let alice = Address::generate(&env);
                let oracle = Address::generate(&env);
                let challenger = Address::generate(&env);
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

                contracts.oc_client.register_provider(
                    &admin,
                    &oracle,
                    &Symbol::new(&env, "verra_vcs"),
                    &0,
                );
                contracts.oc_client.add_stake(&oracle, &stake, &0);

                let report_id = contracts.oc_client.submit_report(
                    &oracle,
                    &project_id,
                    &1000u64,
                    &2000u64,
                    &100_000i128,
                    &BiodiversityMetrics::Absent,
                    &Symbol::new(&env, "verra_vcs"),
                    &make_ipfs_hash(&env, 1),
                    &1,
                );
                contracts.oc_client.challenge_report(
                    &challenger,
                    &report_id,
                    &make_ipfs_hash(&env, 2),
                    &0,
                );
                contracts.oc_client.resolve_challenge(
                    &admin,
                    &report_id,
                    &ReportStatus::Rejected,
                    &1,
                );

                let ppm = nbbs_oracle_consumer::SLASH_PENALTY_PPM;
                let expected = if stake >= 10 {
                    stake - stake * ppm / 1_000_000
                } else {
                    0
                };
                let provider = contracts.oc_client.get_provider(&oracle);
                prop_assert_eq!(provider.stake, expected);
                prop_assert!(provider.stake >= 0);
                prop_assert_eq!(provider.active, provider.stake > 0);
            }
        }

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
            // 9_000 total subscribed out of 10_000. Nonces are per-address, so
            // charlie's first call is 0 even though bob already subscribed.
            contracts
                .bi_client
                .subscribe(&charlie, &bond_id, &6_000, &0);

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

            // DEFAULT_SIGNATURE_THRESHOLD is 2, so a second independently staked
            // verifier is needed before the report reaches Verified and the coupon
            // can be distributed.
            let second_verifier = Address::generate(&env);
            contracts.oc_client.register_provider(
                &admin,
                &second_verifier,
                &Symbol::new(&env, "satellite"),
                &2,
            );
            contracts.oc_client.add_stake(
                &second_verifier,
                &nbbs_oracle_consumer::DEFAULT_MIN_VERIFIER_STAKE,
                &0,
            );
            contracts
                .oc_client
                .verify_report(&second_verifier, &report_id, &1);

            contracts
                .ce_client
                .register_bond(&admin, &bond_id, &project_id, &0);

            let holders = soroban_sdk::vec![&env, bob.clone(), charlie.clone()];
            let dist_result = contracts
                .ce_client
                .distribute_coupon(&admin, &bond_id, &0, &holders, &report_id, &1);

            // The credit pool is carbon / CREDIT_DIVISOR * CREDIT_MINOR_UNITS,
            // i.e. 100_000 / 1_000 * 1_000_000.
            let credit_pool = 100i128 * nbbs_coupon_engine::CREDIT_MINOR_UNITS;

            // Holders split the pool by their share of *subscribed* tokens, not of
            // total supply, so with 9_000 of 10_000 subscribed bob takes 3/9 and
            // charlie 6/9. Both floor, leaving 1 minor unit of dust.
            // `DistributionResult::total_credits` reports the amount actually
            // distributed, not the pool, so it is the pool minus that dust.
            assert_eq!(dist_result.total_credits, credit_pool - 1);

            let bob_accrued = contracts.ce_client.accrued_credits(&bond_id, &bob);
            let charlie_accrued = contracts.ce_client.accrued_credits(&bond_id, &charlie);
            let undistributed = contracts.ce_client.get_undistributed_total(&bond_id);

            assert_eq!(bob_accrued, 33_333_333);
            assert_eq!(charlie_accrued, 66_666_666);
            assert_eq!(undistributed, 1);

            // Conservation invariant: every minor unit of the pool is either accrued
            // to a holder or held as undistributed dust. Stated against the pool
            // rather than `dist_result.total_credits`, which is the distributed
            // subtotal and so already excludes the dust.
            assert_eq!(bob_accrued + charlie_accrued + undistributed, credit_pool);
            assert_eq!(bob_accrued + charlie_accrued, dist_result.total_credits);

            // Bob retires 10 whole credits. Retirement settles against the
            // coupon ledger, so his accrued balance drops by exactly that amount.
            let ten_credits = 10 * nbbs_coupon_engine::CREDIT_MINOR_UNITS;
            contracts.cr_client.retire_credits(
                &bob,
                &bond_id,
                &ten_credits,
                &CreditType::Carbon,
                &make_ipfs_hash(&env, 42),
                &0,
            );
            let bob_remaining = bob_accrued - ten_credits;
            assert_eq!(
                contracts.ce_client.accrued_credits(&bond_id, &bob),
                bob_remaining
            );
            assert_eq!(contracts.cr_client.get_total_retired(&bob), ten_credits);

            // Claiming one minor unit more than remains must fail. The contract
            // returns Err, so the host rolls the frame back and bob's nonce is not
            // consumed by the failed attempt.
            let res = contracts.cr_client.try_retire_credits(
                &bob,
                &bond_id,
                &(bob_remaining + 1),
                &CreditType::Carbon,
                &make_ipfs_hash(&env, 43),
                &1,
            );
            assert!(res.is_err());

            // Admin sweeps the rounding dust.
            let swept = contracts
                .ce_client
                .sweep_undistributed(&admin, &bond_id, &2);
            assert_eq!(swept, undistributed);
            assert_eq!(contracts.ce_client.get_undistributed_total(&bond_id), 0);

            // Post-sweep retirement of the exact remainder succeeds, and bob is
            // then fully retired: one more minor unit is refused.
            contracts.cr_client.retire_credits(
                &bob,
                &bond_id,
                &bob_remaining,
                &CreditType::Carbon,
                &make_ipfs_hash(&env, 44),
                &1,
            );
            let bob_retired = contracts.cr_client.get_total_retired(&bob);
            assert_eq!(bob_retired, bob_accrued);
            assert_eq!(contracts.ce_client.accrued_credits(&bond_id, &bob), 0);
            assert!(contracts
                .cr_client
                .try_retire_credits(
                    &bob,
                    &bond_id,
                    &1,
                    &CreditType::Carbon,
                    &make_ipfs_hash(&env, 45),
                    &2,
                )
                .is_err());

            // Retired credits cannot be claimed again: the double-spend path is closed.
            assert_eq!(contracts.ce_client.claim_credits(&bob, &bond_id, &0), 0);

            // Final accounting: every minor unit of the pool is retired, still
            // accrued to a holder, or swept. Nothing is created or lost.
            let charlie_retired = contracts.cr_client.get_total_retired(&charlie);
            assert_eq!(charlie_retired, 0);
            let charlie_remaining = contracts.ce_client.accrued_credits(&bond_id, &charlie);
            assert_eq!(charlie_remaining, charlie_accrued);

            assert_eq!(
                bob_retired
                    + charlie_retired
                    + charlie_remaining
                    + swept
                    + contracts.ce_client.get_undistributed_total(&bond_id),
                credit_pool
            );
        }
    }

    mod storage_schema {
        use super::*;
        use nbbs_storage::{generate_storage_fixtures, StorageKeyFixture};
        use std::collections::BTreeMap;

        fn fixture_path() -> std::path::PathBuf {
            let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            p.push("fixtures");
            p.push("storage_keys.json");
            p
        }

        fn current() -> BTreeMap<String, BTreeMap<String, StorageKeyFixture>> {
            generate_storage_fixtures(&Env::default())
        }

        #[test]
        fn storage_fixture_file_matches_current_schema() {
            let path = fixture_path();
            assert!(
                path.exists(),
                "missing storage_keys.json fixture; regenerate with: cargo test -p nbbs-storage --features storage-fixture-update regenerate_storage_fixture_file"
            );
            let raw =
                std::fs::read_to_string(&path).expect("failed to read storage_keys.json fixture");
            let on_disk: BTreeMap<String, BTreeMap<String, StorageKeyFixture>> =
                serde_json::from_str(&raw)
                    .expect("storage_keys.json is not valid JSON (regenerate fixtures)");
            assert_eq!(
                on_disk, current(),
                "storage_keys.json is stale or drifted from the DataKey enums — regenerate fixtures"
            );
        }

        #[cfg(feature = "storage-fixture-update")]
        #[test]
        fn regenerate_storage_fixture_file() {
            let fixtures = current();
            let pretty =
                serde_json::to_string_pretty(&fixtures).expect("serialize storage fixtures");
            std::fs::create_dir_all(fixture_path().parent().unwrap()).expect("mkdir fixtures");
            let mut content = pretty;
            content.push('\n');
            std::fs::write(&fixture_path(), content).expect("write storage_keys.json");
            eprintln!("wrote {}", fixture_path().display());
        }
    }
}
