# Governance Proposal Simulation for Parameter Changes (#615)

## Overview
`Governance::simulate_parameter_change` in `contracts/governance/src/lib.rs` provides a read-only on-chain dry-run for parameter-change proposals, complementing the offline snapshot simulator in `contracts/governance-sandbox/src/lib.rs`.

## Checks Performed
1. **Authorization**: Caller must be a registered governance signer (`GovernanceError::NotSigner`).
2. **Allow-List**: `(target, method)` must be explicitly allow-listed.
3. **Track Policy**: Validates `GovernanceTrack` (`Routine`, `Critical`, `Emergency`) against `get_method_min_track` and emergency method restrictions.
4. **Pause Guard**: Reports `target_paused` if `DataKey::Paused(target)` is set.
5. **Parameter Bounds**: Enforces `min_allowed <= proposed_value <= max_allowed` and computes signed `delta` plus `earliest_execution_at`.

## Read-Only & Rollback Invariant
`simulate_parameter_change` never mutates storage and never consumes a signer nonce, so failed or repeated simulations require no state rollback and can be retried after fixing track selection, parameter bounds, or allow-list configuration.
