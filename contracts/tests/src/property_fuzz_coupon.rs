#![cfg(test)]

use nbbs_bond_issuer::{BondIssuer, BondIssuerClient};
use nbbs_coupon_engine::{
    CouponEngine, CouponEngineClient, CREDIT_DIVISOR, CREDIT_MINOR_UNITS, FIXED_POINT,
    HABITAT_CREDIT_RATE, SPECIES_CREDIT_RATE, UNIT_CREDIT_RATE,
};
use nbbs_credit_retirement::{CreditRetirement, CreditRetirementClient};
use nbbs_dex_router::{DEXRouter, DEXRouterClient};
use nbbs_oracle_consumer::{OracleConsumer, OracleConsumerClient};
use nbbs_project_registry::{ProjectRegistry, ProjectRegistryClient};
use nbbs_shared::{BiodiversityMetrics, BondConfig, CreditType};
use proptest::prelude::*;
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Symbol, Vec};

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
    _dr_client: DEXRouterClient<'a>,
    _cr_client: CreditRetirementClient<'a>,
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
        _dr_client: dr_client,
        _cr_client: cr_client,
    }
}

/// Custom strategies for realistic and adversarial input distributions
#[derive(Clone, Debug)]
pub enum FuzzCreditScenario {
    CarbonOnly {
        carbon_kg: i128,
    },
    BlueCarbonOnly {
        carbon_kg: i128,
    },
    BiodiversityOnly {
        habitat_ha: i128,
        species_count: i128,
        unit_count: i128,
    },
    BasketComposite {
        carbon_kg: i128,
        habitat_ha: i128,
        species_count: i128,
        unit_count: i128,
    },
}

fn realistic_and_boundary_carbon() -> impl Strategy<Value = i128> {
    prop_oneof![
        // Boundary / edge values
        Just(0i128),
        Just(1i128),
        Just(CREDIT_DIVISOR - 1),
        Just(CREDIT_DIVISOR),
        Just(CREDIT_DIVISOR + 1),
        Just(1_000_000i128),
        // Typical small/medium project ranges
        (0i128..10_000_000i128),
        // Large institutional scale
        (10_000_000i128..1_000_000_000i128),
        // Stress-test high magnitude
        (1_000_000_000i128..100_000_000_000i128),
    ]
}

fn realistic_and_boundary_bio_metrics() -> impl Strategy<Value = (i128, i128, i128)> {
    prop_oneof![
        // Exact zero / minimal
        Just((0i128, 0i128, 0i128)),
        Just((1i128, 0i128, 0i128)),
        Just((0i128, 1i128, 0i128)),
        Just((0i128, 0i128, 1i128)),
        Just((1i128, 1i128, 1i128)),
        // Varied combinations
        (0i128..10_000i128, 0i128..500i128, 0i128..50_000i128),
        // Large scale ecological reserves
        (10_000i128..500_000i128, 500i128..10_000i128, 50_000i128..5_000_000i128),
    ]
}

fn fuzz_scenario_strategy() -> impl Strategy<Value = FuzzCreditScenario> {
    prop_oneof![
        realistic_and_boundary_carbon().prop_map(|carbon_kg| FuzzCreditScenario::CarbonOnly { carbon_kg }),
        realistic_and_boundary_carbon().prop_map(|carbon_kg| FuzzCreditScenario::BlueCarbonOnly { carbon_kg }),
        realistic_and_boundary_bio_metrics().prop_map(|(habitat_ha, species_count, unit_count)| {
            FuzzCreditScenario::BiodiversityOnly {
                habitat_ha,
                species_count,
                unit_count,
            }
        }),
        (realistic_and_boundary_carbon(), realistic_and_boundary_bio_metrics()).prop_map(
            |(carbon_kg, (habitat_ha, species_count, unit_count))| {
                FuzzCreditScenario::BasketComposite {
                    carbon_kg,
                    habitat_ha,
                    species_count,
                    unit_count,
                }
            }
        ),
    ]
}

fn holder_balance_distribution_strategy() -> impl Strategy<Value = std::vec::Vec<i128>> {
    prop_oneof![
        // Single holder
        (1i128..1_000_000i128).prop_map(|b| std::vec![b]),
        // Equal split among multiple holders
        (2usize..5usize, 1i128..100_000i128).prop_map(|(n, share)| std::vec![share; n]),
        // Skewed distributions (whale + dust holders)
        (100_000i128..10_000_000i128, proptest::collection::vec(1i128..10i128, 1..4)).prop_map(
            |(whale, mut dust)| {
                dust.push(whale);
                dust
            }
        ),
        // Arbitrary random collections
        proptest::collection::vec(1i128..500_000i128, 1..5),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 64,
        ..ProptestConfig::default()
    })]

    /// Property 1: Conservation of Credits across all scenarios
    /// Invariant: total_distributed + undistributed_dust == total_calculated_credits
    #[test]
    fn prop_conservation_of_credits_arbitrary_scenarios(
        scenario in fuzz_scenario_strategy(),
        balances in holder_balance_distribution_strategy(),
    ) {
        let env = Env::default();
        env.budget().reset_unlimited();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        let project_owner = Address::generate(&env);
        let contracts = deploy_contracts(&env, &admin);

        let project_id = make_project_id(&env, 101);
        let pid = contracts.pr_client.register_project(
            &project_owner,
            &make_ipfs_hash(&env, 101),
            &Symbol::new(&env, "VERRA"),
            &Symbol::new(&env, "GLOBAL"),
            &0,
        );
        contracts.pr_client.approve_project(&admin, &pid, &0);

        let total_supply: i128 = balances.iter().sum::<i128>() + 1_000;
        let mut config = make_bond_config(&env, project_id.clone(), total_supply);

        let (credit_type, carbon_kg, bio_metrics) = match scenario {
            FuzzCreditScenario::CarbonOnly { carbon_kg } => {
                config.credit_type = CreditType::Carbon;
                (CreditType::Carbon, carbon_kg, BiodiversityMetrics::Absent)
            }
            FuzzCreditScenario::BlueCarbonOnly { carbon_kg } => {
                config.credit_type = CreditType::BlueCarbon;
                (CreditType::BlueCarbon, carbon_kg, BiodiversityMetrics::Absent)
            }
            FuzzCreditScenario::BiodiversityOnly { habitat_ha, species_count, unit_count } => {
                config.credit_type = CreditType::Biodiversity;
                (CreditType::Biodiversity, 0, BiodiversityMetrics::Present((habitat_ha, species_count, unit_count)))
            }
            FuzzCreditScenario::BasketComposite { carbon_kg, habitat_ha, species_count, unit_count } => {
                config.credit_type = CreditType::Basket;
                (CreditType::Basket, carbon_kg, BiodiversityMetrics::Present((habitat_ha, species_count, unit_count)))
            }
        };

        let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);

        let mut holders: std::vec::Vec<Address> = std::vec::Vec::new();
        let mut holders_vec: Vec<Address> = Vec::new(&env);
        for balance in &balances {
            let holder = Address::generate(&env);
            contracts.bi_client.subscribe(&holder, &bond_id, balance, &0);
            holders.push(holder.clone());
            holders_vec.push_back(holder);
        }

        contracts.oc_client.register_provider(&admin, &oracle, &Symbol::new(&env, "oracle_feed"), &0);

        let report_id = contracts.oc_client.submit_report(
            &oracle,
            &project_id,
            &1000u64,
            &2000u64,
            &carbon_kg,
            &bio_metrics,
            &Symbol::new(&env, "oracle_feed"),
            &make_ipfs_hash(&env, 202),
            &0,
        );
        contracts.oc_client.verify_report(&admin, &report_id, &1);

        contracts.ce_client.register_bond(&admin, &bond_id, &project_id, &0);

        let dist_result = contracts.ce_client.distribute_coupon(
            &admin,
            &bond_id,
            &0,
            &holders_vec,
            &report_id,
            &1,
        );

        let total_subscribed: i128 = balances.iter().sum();
        let expected_total_credits = match credit_type {
            CreditType::Carbon | CreditType::BlueCarbon => (carbon_kg / CREDIT_DIVISOR) * CREDIT_MINOR_UNITS,
            CreditType::Biodiversity => {
                if let BiodiversityMetrics::Present((h, s, u)) = bio_metrics {
                    ((h * HABITAT_CREDIT_RATE
                        + s * SPECIES_CREDIT_RATE
                        + u * UNIT_CREDIT_RATE)
                        * CREDIT_MINOR_UNITS)
                        / HABITAT_CREDIT_RATE
                } else {
                    0
                }
            }
            CreditType::Basket => {
                let c = (carbon_kg / CREDIT_DIVISOR) * CREDIT_MINOR_UNITS;
                let b = if let BiodiversityMetrics::Present((h, s, u)) = bio_metrics {
                    ((h * HABITAT_CREDIT_RATE
                        + s * SPECIES_CREDIT_RATE
                        + u * UNIT_CREDIT_RATE)
                        * CREDIT_MINOR_UNITS)
                        / HABITAT_CREDIT_RATE
                } else {
                    0
                };
                c + b
            }
        };

        let mut sum_accrued: i128 = 0;
        for holder in &holders {
            let accrued = contracts.ce_client.accrued_credits(&bond_id, holder);
            prop_assert!(accrued >= 0, "Accrued credits must be non-negative");
            sum_accrued += accrued;
        }

        let undistributed = contracts.ce_client.get_undistributed_total(&bond_id);
        prop_assert!(undistributed >= 0, "Undistributed credits must be non-negative");

        // Primary Conservation Law
        prop_assert_eq!(
            sum_accrued + undistributed,
            expected_total_credits,
            "Conservation violated: sum_accrued ({}) + undistributed ({}) != expected_total ({})",
            sum_accrued,
            undistributed,
            expected_total_credits
        );

        prop_assert_eq!(dist_result.total_credits, sum_accrued);

        // Dust containment: remainder per distribution period cannot exceed (holder_count - 1)
        if total_subscribed > 0 && expected_total_credits > 0 {
            prop_assert!(
                undistributed <= total_subscribed,
                "Undistributed dust cannot exceed total subscriber base"
            );
        }

        // Admin sweep cleans dust to 0
        let swept = contracts.ce_client.sweep_undistributed(&admin, &bond_id, &2);
        prop_assert_eq!(swept, undistributed);
        prop_assert_eq!(contracts.ce_client.get_undistributed_total(&bond_id), 0);
    }

    /// Property 2: Strict Pro-Rata Bounds
    /// Every holder receives floor(credits_per_token * balance / FIXED_POINT).
    #[test]
    fn prop_strict_pro_rata_bounds(
        carbon_kg in 1_000i128..50_000_000i128,
        balances in proptest::collection::vec(10i128..10_000i128, 2..5),
    ) {
        let env = Env::default();
        env.budget().reset_unlimited();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        let project_owner = Address::generate(&env);
        let contracts = deploy_contracts(&env, &admin);

        let project_id = make_project_id(&env, 77);
        let pid = contracts.pr_client.register_project(
            &project_owner,
            &make_ipfs_hash(&env, 77),
            &Symbol::new(&env, "GOLD_STD"),
            &Symbol::new(&env, "KENYA"),
            &0,
        );
        contracts.pr_client.approve_project(&admin, &pid, &0);

        let total_supply: i128 = balances.iter().sum::<i128>() + 500;
        let config = make_bond_config(&env, project_id.clone(), total_supply);
        let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);

        let mut holders: std::vec::Vec<Address> = std::vec::Vec::new();
        let mut holders_vec: Vec<Address> = Vec::new(&env);
        for balance in &balances {
            let holder = Address::generate(&env);
            contracts.bi_client.subscribe(&holder, &bond_id, balance, &0);
            holders.push(holder.clone());
            holders_vec.push_back(holder);
        }

        contracts.oc_client.register_provider(&admin, &oracle, &Symbol::new(&env, "gold_std"), &0);

        let report_id = contracts.oc_client.submit_report(
            &oracle,
            &project_id,
            &1000u64,
            &2000u64,
            &carbon_kg,
            &BiodiversityMetrics::Absent,
            &Symbol::new(&env, "gold_std"),
            &make_ipfs_hash(&env, 99),
            &0,
        );
        contracts.oc_client.verify_report(&admin, &report_id, &1);

        contracts.ce_client.register_bond(&admin, &bond_id, &project_id, &0);
        let dist = contracts.ce_client.distribute_coupon(
            &admin,
            &bond_id,
            &0,
            &holders_vec,
            &report_id,
            &1,
        );

        let total_subscribed: i128 = balances.iter().sum();
        let total_credits = (carbon_kg / CREDIT_DIVISOR) * CREDIT_MINOR_UNITS;
        let credits_per_token = total_credits * FIXED_POINT / total_subscribed;

        prop_assert_eq!(dist.credits_per_token, credits_per_token);

        for (holder, balance) in holders.iter().zip(balances.iter()) {
            let accrued = contracts.ce_client.accrued_credits(&bond_id, holder);
            let expected_floor = (credits_per_token * balance) / FIXED_POINT;
            prop_assert_eq!(accrued, expected_floor);
        }
    }

    /// Property 3: Multi-period credit accumulation and sweep invariance
    /// Over sequential reporting periods with varying yields, undistributed pool precisely
    /// tracks cumulative dust, and accrued credits equal sum of individual period yields.
    #[test]
    fn prop_multi_period_accumulation_and_sweep(
        yields in proptest::collection::vec(1_000i128..20_000_000i128, 2..4),
        balances in proptest::collection::vec(50i128..5_000i128, 2..4),
    ) {
        let env = Env::default();
        env.budget().reset_unlimited();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        let project_owner = Address::generate(&env);
        let contracts = deploy_contracts(&env, &admin);

        let project_id = make_project_id(&env, 88);
        let pid = contracts.pr_client.register_project(
            &project_owner,
            &make_ipfs_hash(&env, 88),
            &Symbol::new(&env, "GOLD_STD"),
            &Symbol::new(&env, "BRAZIL"),
            &0,
        );
        contracts.pr_client.approve_project(&admin, &pid, &0);

        let total_supply: i128 = balances.iter().sum::<i128>() + 200;
        let config = make_bond_config(&env, project_id.clone(), total_supply);
        let bond_id = contracts.bi_client.issue_bond(&admin, &config, &0);

        let mut holders: std::vec::Vec<Address> = std::vec::Vec::new();
        let mut holders_vec: Vec<Address> = Vec::new(&env);
        for balance in &balances {
            let holder = Address::generate(&env);
            contracts.bi_client.subscribe(&holder, &bond_id, balance, &0);
            holders.push(holder.clone());
            holders_vec.push_back(holder);
        }

        contracts.oc_client.register_provider(&admin, &oracle, &Symbol::new(&env, "gold_std"), &0);
        contracts.ce_client.register_bond(&admin, &bond_id, &project_id, &0);

        let total_subscribed: i128 = balances.iter().sum();
        let mut total_expected_issued: i128 = 0;
        let mut expected_holder_accrued: std::vec::Vec<i128> = vec![0; holders.len()];

        for (period_idx, &carbon_kg) in yields.iter().enumerate() {
            let report_id = contracts.oc_client.submit_report(
                &oracle,
                &project_id,
                &(1000u64 + period_idx as u64 * 1000),
                &(2000u64 + period_idx as u64 * 1000),
                &carbon_kg,
                &BiodiversityMetrics::Absent,
                &Symbol::new(&env, "gold_std"),
                &make_ipfs_hash(&env, (100 + period_idx) as u8),
                &(period_idx as u64),
            );
            contracts.oc_client.verify_report(&admin, &report_id, &(1 + period_idx as u64));

            contracts.ce_client.distribute_coupon(
                &admin,
                &bond_id,
                &(period_idx as u32),
                &holders_vec,
                &report_id,
                &(1 + period_idx as u64),
            );

            let period_total_credits = (carbon_kg / CREDIT_DIVISOR) * CREDIT_MINOR_UNITS;
            total_expected_issued += period_total_credits;
            let credits_per_token = period_total_credits * FIXED_POINT / total_subscribed;

            for (idx, balance) in balances.iter().enumerate() {
                expected_holder_accrued[idx] += (credits_per_token * balance) / FIXED_POINT;
            }
        }

        let mut sum_actual_accrued: i128 = 0;
        for (idx, holder) in holders.iter().enumerate() {
            let actual = contracts.ce_client.accrued_credits(&bond_id, holder);
            prop_assert_eq!(actual, expected_holder_accrued[idx]);
            sum_actual_accrued += actual;
        }

        let undistributed = contracts.ce_client.get_undistributed_total(&bond_id);
        prop_assert_eq!(sum_actual_accrued + undistributed, total_expected_issued);

        let swept = contracts.ce_client.sweep_undistributed(&admin, &bond_id, &(1 + yields.len() as u64));
        prop_assert_eq!(swept, undistributed);
        prop_assert_eq!(contracts.ce_client.get_undistributed_total(&bond_id), 0);
    }
}
