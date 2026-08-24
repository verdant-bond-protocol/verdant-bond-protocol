# Governance

## Multi-Stakeholder Committee
- Project Developers
- Bond Issuers
- Oracle Providers
- Protocol Maintainers
- Token Holders

## Governance Actions (3-of-5 Multi-sig)
- Add/remove oracle providers
- Update credit conversion factors
- Deploy contract upgrades (48h timelock)
- Modify KYC requirements
- Adjust dispute resolution parameters

## Self-Amending Governance

The governance contract supports modifying its own parameters through the standard proposal/timelock/multi-sig flow. This means signer rotation, threshold changes, and timelock adjustments go through the same governance process as any other action — no admin backdoor.

### Available Self-Amendment Functions

All self-amendment functions can only be called by the governance contract itself (routed through `propose` → `vote_approve` → `execute`). Direct external calls are rejected with `Unauthorized`.

| Function | Description | Guardrails |
|---|---|---|
| `add_signer(new_signer)` | Add a new signer to the multi-sig set | Rejected if signer already exists |
| `remove_signer(signer_to_remove)` | Remove an existing signer | Rejected if removal would leave fewer than 3 signers, or if threshold would exceed new signer count |
| `set_threshold(new_threshold)` | Change the approval threshold | Must be ≥ 2 and ≤ current signer count |
| `set_timelock(new_timelock)` | Change the proposal timelock | Must be > 0 |

### Self-Amendment Flow

1. A signer calls `propose` with `target` set to the governance contract's own address and `method` set to one of the self-amendment function names (e.g., `"add_signer"`)
2. The proposal args contain only the function-specific parameters (not the `caller` — that is automatically set to the governance contract address during execution)
3. Signers vote via `vote_approve` as usual
4. After the timelock period, anyone calls `execute`
5. The governance contract invokes the self-amendment function on itself, with `caller = env.current_contract_address()`

### Example: Adding a Signer

```
propose(
  caller: signer_A,
  target: governance_contract_address,
  method: "add_signer",
  args: [new_signer_address],
  description: "Replace departing team member",
  nonce: 0
)
// 3 signers approve...
execute(caller: signer_A, proposal_id: 1, nonce: 1)
// governance contract calls add_signer on itself
// new_signer is now part of the multi-sig set
```

### Safety Guarantees

- **No admin backdoor**: All signer/threshold/timelock changes require the full governance process
- **Threshold floor**: Threshold can never drop below 2
- **Signer floor**: Signer count can never drop below 3
- **Threshold bound**: Threshold can never exceed signer count
- **Proposal safety**: Existing pending proposals are not affected by mid-flight signer changes
- **Replay protection**: All self-amendment functions use nonce-based replay protection
