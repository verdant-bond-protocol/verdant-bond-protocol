//! Offline execution of deployed contract code. No RPC client, signer, or submit path.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use soroban_ledger_snapshot::LedgerSnapshot;
use soroban_sdk::{xdr, Address, Env, Error, Symbol, TryFromVal, Val, Vec};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Call {
    pub contract: String,
    pub method: String,
    /// Canonical ScVal JSON; integers retain their full on-chain precision.
    pub args: std::vec::Vec<xdr::ScVal>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Fees,
    Covenants,
    OracleConfig,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub label: String,
    pub explanation: String,
    pub category: Category,
    pub unit: String,
    /// Each probe runs in its own fresh fork. Last call is the displayed result.
    pub calls: std::vec::Vec<Call>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub proposal_id: String,
    pub network_passphrase: String,
    pub ledger_sequence: u32,
    pub snapshot_sha256: String,
    /// Exact target/method/args from the governance proposal (including nonce).
    pub proposal: Call,
    pub probes: std::vec::Vec<Probe>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Outcome {
    Success { value: String },
    Failure { error: String },
}

#[derive(Serialize)]
pub struct Diff {
    pub label: String,
    pub explanation: String,
    pub category: Category,
    pub unit: String,
    pub before: Outcome,
    pub after: Outcome,
    pub changed: bool,
}

#[derive(Serialize)]
pub struct Report {
    pub version: u32,
    pub proposal_id: String,
    pub ledger_sequence: u32,
    pub ledger_timestamp: u64,
    pub snapshot_sha256: String,
    pub network_passphrase: String,
    pub authorization: &'static str,
    pub proposal: Call,
    pub proposal_result: Outcome,
    pub diffs: std::vec::Vec<Diff>,
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn call(env: &Env, call: &Call) -> Outcome {
    let address = Address::from_string(&soroban_sdk::String::from_str(env, &call.contract));
    let mut args = Vec::<Val>::new(env);
    for arg in &call.args {
        match Val::try_from_val(env, arg) {
            Ok(val) => args.push_back(val),
            Err(_) => {
                return Outcome::Failure {
                    error: "Invalid contract argument".into(),
                }
            }
        }
    }
    match env.try_invoke_contract::<Val, Error>(&address, &Symbol::new(env, &call.method), args) {
        Ok(Ok(value)) => match xdr::ScVal::try_from_val(env, &value) {
            Ok(value) => Outcome::Success {
                value: display(&value),
            },
            Err(_) => Outcome::Failure {
                error: "Cannot decode contract result".into(),
            },
        },
        other => Outcome::Failure {
            error: format!("Contract execution failed: {other:?}"),
        },
    }
}

fn display(value: &xdr::ScVal) -> String {
    match value {
        xdr::ScVal::Void => "Completed".into(),
        xdr::ScVal::Bool(v) => if *v { "Yes" } else { "No" }.into(),
        xdr::ScVal::U32(v) => v.to_string(),
        xdr::ScVal::I32(v) => v.to_string(),
        xdr::ScVal::U64(v) => v.to_string(),
        xdr::ScVal::I64(v) => v.to_string(),
        xdr::ScVal::U128(v) => (((v.hi as u128) << 64) | v.lo as u128).to_string(),
        xdr::ScVal::I128(v) => (((v.hi as i128) << 64) | v.lo as i128).to_string(),
        xdr::ScVal::Symbol(v) => String::from_utf8_lossy(v.as_ref()).into_owned(),
        xdr::ScVal::String(v) => String::from_utf8_lossy(v.as_ref()).into_owned(),
        xdr::ScVal::Vec(Some(v)) => v
            .iter()
            .map(display)
            .collect::<std::vec::Vec<_>>()
            .join(", "),
        xdr::ScVal::Map(Some(v)) => v
            .iter()
            .map(|e| format!("{}: {}", display(&e.key), display(&e.val)))
            .collect::<std::vec::Vec<_>>()
            .join("; "),
        other => format!("{other:?}"),
    }
}

fn fork(snapshot: &LedgerSnapshot) -> Env {
    let mut env = Env::from_ledger_snapshot(snapshot.clone());
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    // Permission is assumed only in this offline impact forecast. Contract role,
    // nonce, allow-list and business-rule checks still execute normally.
    env.mock_all_auths_allowing_non_root_auth();
    env
}

pub fn simulate(snapshot_bytes: &[u8], plan: &Plan) -> Result<Report, String> {
    let snapshot: LedgerSnapshot =
        serde_json::from_slice(snapshot_bytes).map_err(|e| e.to_string())?;
    if snapshot.sequence_number != plan.ledger_sequence
        || digest(snapshot_bytes) != plan.snapshot_sha256
    {
        return Err("Snapshot ledger or hash does not match the proposal plan".into());
    }
    let network: [u8; 32] = Sha256::digest(plan.network_passphrase.as_bytes()).into();
    if snapshot.network_id != network {
        return Err("Snapshot belongs to a different network".into());
    }
    if plan.probes.is_empty() || plan.probes.len() > 100 {
        return Err("Supply 1–100 impact probes".into());
    }
    // Every directly invoked contract must have its real instance and WASM in
    // the snapshot. Never register replacement code or fabricate storage.
    for invocation in
        std::iter::once(&plan.proposal).chain(plan.probes.iter().flat_map(|p| &p.calls))
    {
        let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        let address =
            Address::from_string(&soroban_sdk::String::from_str(&env, &invocation.contract));
        let address: xdr::ScAddress = (&address).into();
        let instance = snapshot
            .ledger_entries
            .iter()
            .find_map(|(_, (entry, ttl))| {
                if let xdr::LedgerEntryData::ContractData(data) = &entry.data {
                    if data.contract == address && data.key == xdr::ScVal::LedgerKeyContractInstance
                    {
                        if ttl.is_some_and(|ttl| ttl < snapshot.sequence_number) {
                            return None;
                        }
                        if let xdr::ScVal::ContractInstance(instance) = &data.val {
                            return Some(instance);
                        }
                    }
                }
                None
            })
            .ok_or_else(|| {
                format!(
                    "Missing or expired deployed contract {}",
                    invocation.contract
                )
            })?;
        if let xdr::ContractExecutable::Wasm(hash) = &instance.executable {
            if !snapshot.ledger_entries.iter().any(|(_, (entry, ttl))| {
                matches!(&entry.data, xdr::LedgerEntryData::ContractCode(code) if code.hash == *hash)
                    && !ttl.is_some_and(|ttl| ttl < snapshot.sequence_number)
            }) { return Err(format!("Missing deployed WASM for {}", invocation.contract)); }
        }
    }
    let proposal_result = call(&fork(&snapshot), &plan.proposal);
    let mut diffs = std::vec::Vec::new();
    for probe in &plan.probes {
        if probe.calls.is_empty() || probe.calls.len() > 20 {
            return Err("Supply 1–20 calls per probe".into());
        }
        let run = |proposed: bool| {
            let env = fork(&snapshot);
            if proposed {
                let result = call(&env, &plan.proposal);
                if matches!(result, Outcome::Failure { .. }) {
                    return result;
                }
            }
            let mut result = Outcome::Success {
                value: "Completed".into(),
            };
            for invocation in &probe.calls {
                result = call(&env, invocation);
                if matches!(result, Outcome::Failure { .. }) {
                    break;
                }
            }
            result
        };
        let before = run(false);
        let after = run(true);
        let changed = before != after;
        diffs.push(Diff {
            label: probe.label.clone(),
            explanation: probe.explanation.clone(),
            category: probe.category.clone(),
            unit: probe.unit.clone(),
            before,
            after,
            changed,
        });
    }
    Ok(Report {
        version: 1,
        proposal_id: plan.proposal_id.clone(),
        ledger_sequence: snapshot.sequence_number,
        ledger_timestamp: snapshot.timestamp,
        snapshot_sha256: plan.snapshot_sha256.clone(),
        network_passphrase: plan.network_passphrase.clone(),
        authorization:
            "Assumes governance authorization; does not validate signatures or vote eligibility",
        proposal: plan.proposal.clone(),
        proposal_result,
        diffs,
    })
}
