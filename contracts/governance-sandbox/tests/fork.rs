use nbbs_governance_sandbox::{digest, simulate, Call, Category, Outcome, Plan, Probe};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    xdr, Address, Env, IntoVal, Symbol, TryFromVal,
};

fn fixture(category: u32) -> (Vec<u8>, Plan) {
    let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.ledger().set_sequence_number(100);
    let admin = Address::generate(&env);
    let wasm = std::fs::read(
        std::env::var("SANDBOX_FIXTURE_WASM")
            .expect("Build the runtime fixture and set SANDBOX_FIXTURE_WASM; see test-sandbox.sh"),
    )
    .unwrap();
    let id = env.register(wasm.as_slice(), (&admin,));
    let contract = id.to_string().to_string();
    let sc = |val: soroban_sdk::Val| xdr::ScVal::try_from_val(&env, &val).unwrap();
    let value = match category {
        0 => 500u32,
        1 => 250,
        _ => 60,
    };
    let proposal = Call {
        contract: contract.clone(),
        method: "set".into(),
        args: vec![
            sc(admin.into_val(&env)),
            sc(category.into_val(&env)),
            sc(value.into_val(&env)),
        ],
    };
    let input = match category {
        0 => 10_000u32,
        1 => 200,
        _ => 100,
    };
    let probe = Probe {
        label: "Impact".into(),
        explanation: "Executed deployed WASM".into(),
        category: match category {
            0 => Category::Fees,
            1 => Category::Covenants,
            _ => Category::OracleConfig,
        },
        unit: "minor units / allowed".into(),
        calls: vec![Call {
            contract,
            method: "impact".into(),
            args: vec![sc(category.into_val(&env)), sc(input.into_val(&env))],
        }],
    };
    let mut snapshot = env.to_ledger_snapshot();
    snapshot.network_id = sha2::Sha256::digest(b"Test network").into();
    let bytes = serde_json::to_vec(&snapshot).unwrap();
    let plan = Plan {
        proposal_id: "test".into(),
        network_passphrase: "Test network".into(),
        ledger_sequence: 100,
        snapshot_sha256: digest(&bytes),
        proposal,
        probes: vec![probe],
    };
    (bytes, plan)
}
use sha2::Digest;

#[test]
fn deployed_wasm_fee_covenant_and_oracle_proposals_have_isolated_downstream_diffs() {
    for (category, before, after) in [(0, "100", "500"), (1, "1", "0"), (2, "1", "0")] {
        let (bytes, mut plan) = fixture(category);
        // Two independent probes must see identical baseline/proposal state.
        plan.probes.push(Probe {
            label: "Repeat".into(),
            explanation: "Isolation".into(),
            category: plan.probes[0].category.clone(),
            unit: plan.probes[0].unit.clone(),
            calls: plan.probes[0].calls.clone(),
        });
        let original = bytes.clone();
        let report = simulate(&bytes, &plan).unwrap();
        assert!(matches!(report.proposal_result, Outcome::Success { .. }));
        for diff in report.diffs {
            assert_eq!(
                diff.before,
                Outcome::Success {
                    value: before.into()
                }
            );
            assert_eq!(
                diff.after,
                Outcome::Success {
                    value: after.into()
                }
            );
            assert!(diff.changed);
        }
        assert_eq!(bytes, original);
        assert_eq!(
            simulate(&bytes, &plan).unwrap().diffs[0].after,
            Outcome::Success {
                value: after.into()
            }
        );
        // Loading the original snapshot still gives the original value.
        let env = Env::from_ledger_snapshot(
            serde_json::from_slice::<soroban_ledger_snapshot::LedgerSnapshot>(&bytes).unwrap(),
        );
        let call = &plan.probes[0].calls[0];
        let args = soroban_sdk::Vec::from_iter(
            &env,
            call.args
                .iter()
                .map(|v| soroban_sdk::Val::try_from_val(&env, v).unwrap()),
        );
        let id = Address::from_string(&soroban_sdk::String::from_str(&env, &call.contract));
        let result: u32 = env.invoke_contract(&id, &Symbol::new(&env, "impact"), args);
        assert_eq!(result.to_string(), before);
    }
}

#[test]
fn mismatched_snapshot_and_missing_deployed_code_fail_closed() {
    let (bytes, mut plan) = fixture(0);
    plan.ledger_sequence += 1;
    assert!(simulate(&bytes, &plan).is_err());
    plan.ledger_sequence -= 1;
    plan.snapshot_sha256 = "0".repeat(64);
    assert!(simulate(&bytes, &plan).is_err());
    plan.snapshot_sha256 = digest(&bytes);
    plan.network_passphrase = "Wrong network".into();
    assert!(simulate(&bytes, &plan).is_err());
    plan.network_passphrase = "Test network".into();
    let mut snapshot: soroban_ledger_snapshot::LedgerSnapshot =
        serde_json::from_slice(&bytes).unwrap();
    snapshot
        .ledger_entries
        .retain(|(_, (entry, _))| !matches!(entry.data, xdr::LedgerEntryData::ContractCode(_)));
    let bytes = serde_json::to_vec(&snapshot).unwrap();
    plan.snapshot_sha256 = digest(&bytes);
    assert!(simulate(&bytes, &plan).is_err());
}

#[test]
fn unsupported_proposals_are_reported_as_failure_not_a_fabricated_forecast() {
    let (bytes, mut plan) = fixture(0);
    plan.proposal.method = "nonexistent_fee_setter".into();
    let report = simulate(&bytes, &plan).unwrap();
    assert!(matches!(report.proposal_result, Outcome::Failure { .. }));
    assert!(matches!(report.diffs[0].before, Outcome::Success { .. }));
    assert!(matches!(report.diffs[0].after, Outcome::Failure { .. }));
}

#[test]
fn mutating_probes_cannot_contaminate_other_scenarios() {
    let (bytes, mut plan) = fixture(0);
    let original = plan.probes[0].calls.clone();
    let mut mutation = plan.proposal.clone();
    mutation.args[2] = xdr::ScVal::U32(900);
    plan.probes[0].calls.insert(0, mutation);
    plan.probes.push(Probe {
        label: "Independent fee forecast".into(),
        explanation: "Fresh fork".into(),
        category: Category::Fees,
        unit: "minor units".into(),
        calls: original,
    });
    let report = simulate(&bytes, &plan).unwrap();
    assert_eq!(
        report.diffs[0].before,
        Outcome::Success {
            value: "900".into()
        }
    );
    assert_eq!(
        report.diffs[1].before,
        Outcome::Success {
            value: "100".into()
        }
    );
    assert_eq!(
        report.diffs[1].after,
        Outcome::Success {
            value: "500".into()
        }
    );
}
