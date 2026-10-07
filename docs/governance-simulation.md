# Governance impact sandbox

The host-only `nbbs-governance-sandbox` executable loads a Stellar ledger snapshot
and invokes the deployed WASM in Soroban's local host. It has no RPC submission
client or signing key. It never writes the input snapshot. Each before/after
scenario starts from a separate copy of the same ledger, so probes cannot contaminate
one another. Missing contract instances or WASM fail closed. Contract failures
are displayed explicitly, including unsupported parameter methods.

## Capture and run

Use the official Stellar CLI to capture a recent history-archive checkpoint:

```sh
stellar snapshot create --network mainnet --ledger LEDGER \
  --address GOVERNANCE --address ISSUER --address COUPON_ENGINE \
  --address ORACLE --address DEX --address REGISTRY --out snapshot.json
sha256sum snapshot.json
cd contracts
cargo run --manifest-path governance-sandbox/Cargo.toml -- ../snapshot.json ../plan.json > ../report.json
```

Include every transitive contract and relevant account (including token issuers
and trustlines), not just the proposed target. Use one checkpoint, never a merge
of different ledgers. Preserve the snapshot as the audit input. The report binds
its exact SHA-256, network passphrase, ledger sequence and timestamp; a mismatched
plan is rejected. The checkpoint may lag the live ledger: refresh before voting.
Snapshot provenance must be checked against the configured archive; a fingerprint
identifies the input but is not a cryptographic proof of archive authenticity.

The plan contains `proposal_id`, `network_passphrase`, `ledger_sequence`,
`snapshot_sha256`, `proposal`, and `probes`. Each call contains `contract`, `method`,
and `args` (canonical Stellar `ScVal` JSON, preserving integer precision). Copy the
exact proposed target, method and arguments, including the target's current nonce.
Do not invoke the timelocked governance `execute` method early: apply its target
call to forecast impact, with authorization assumed locally. Role checks, nonces,
parameter bounds, and downstream contract logic still run. This does not verify
signatures, voting eligibility, quorum, or eventual execution eligibility.

Each probe has a human-readable `label`, `explanation`, `unit`, a `category`
(`fees`, `covenants`, or `oracle_config`), and 1–20 `calls`. The last call's result
is displayed. For parameters, read the getter; for downstream effects, run the
actual action then read its resulting balances/status. Multiple calls in a probe
form a scenario, not a replacement for an atomic contract invocation. Include
both parameter getters and the affected coupon, enforcement and fee-routing
scenarios. The sandbox limits a report to 100 probes and uses host resource limits.

Open `/governance/simulation` in the frontend and import `report.json` for the
before/after table. Reports are local text data, never executable HTML. The table
retains exact integer strings, explains effects, labels failures and identifies
unchanged values. Importing a report does not sign or submit anything.

## Current protocol coverage

Oracle configuration can be exercised through `set_project_staleness_config`,
`get_project_staleness_config`, and `get_project_staleness_state`. Coupon protection
can be exercised through `set_min_performance_attestations` and actual coupon
distribution. This checkout's fee schedules are off-chain API constants; it has
no deployed governance fee-setting entry point. A proposed nonexistent fee method
must be shown as a failed simulation, never silently approximated with API math.
For deployments with governed fee contracts, capture those contracts and probe
their setters and settlement balances using the same engine.

Reference: [Stellar snapshot CLI](https://developers.stellar.org/docs/tools/cli/stellar-cli#stellar-snapshot-create)
and [Soroban local environment](https://docs.rs/soroban-sdk/26.0.1/soroban_sdk/struct.Env.html).
