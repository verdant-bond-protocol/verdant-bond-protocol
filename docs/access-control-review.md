# Cross-Contract Access-Control Review

Scope: every privileged entry point across the seven Soroban contracts in `contracts/` (`ProjectRegistry`, `BondIssuer`, `OracleConsumer`, `CouponEngine`, `DEXRouter`, `CreditRetirement`, `Governance`), the roles that may call each one, how those roles are granted and revoked, and every path by which a role in one contract can change another contract's behaviour.

Method: the function inventory below was extracted from each `#[contractimpl]` block by script (auth calls, `require_admin` guards, nonce parameters, storage writes, cross-contract invocations, events) and then checked by hand against the source. Every finding lists the file and function it comes from, and its status. Escalation paths are either fixed in this change set or explicitly accepted with the reason.

## Roles

| Role | Held by | Granted by | Revoked by |
| --- | --- | --- | --- |
| Contract admin (one per contract) | The `admin` address passed to the constructor, then whatever `set_admin` names | `__constructor`, then `set_admin(current_admin, new_admin, nonce)` by the current admin | The same `set_admin` call. Single step: the new address takes effect immediately and the old one loses the role in the same transaction |
| Governance signer | Fixed `signers` vector passed to `Governance.__constructor` | Construction only | Nothing. There is no `add_signer` / `remove_signer`; rotating the signer set means deploying a new `Governance` and rotating every admin to it |
| Oracle provider | Addresses registered by the oracle admin | `OracleConsumer.register_provider` (admin) | `OracleConsumer.remove_provider` (admin), or slashing the stake to zero |
| Project owner | The address that called `register_project` | Self-registration | Not revocable; the admin can `reject_project` / `deactivate_project` instead |
| Bond holder | Any address with a positive `HolderBalance` | `subscribe`, `transfer`, `execute_purchase` | Transferring the balance away |

The admin of each operational contract is meant to be the `Governance` contract. `scripts/deploy-testnet.sh` wires that at deployment when `GOVERNANCE_ADDRESS` is set. Nothing in the contracts themselves requires it: with a plain account as admin, every privileged function below is single-key and immediate.

## Permission matrix

Legend: A = admin only, S = governance signer only, H = authenticated caller acting on its own balance/record, P = public read. `nonce` means the call consumes the caller's per-contract nonce.

### ProjectRegistry (`contracts/project-registry/src/lib.rs`)

| Function | Role | Writes | Notes |
| --- | --- | --- | --- |
| `register_project` | H, nonce | `Project`, `OwnerProjects`, `ProjectCount` | Anyone may register; starts `Pending` |
| `approve_project`, `reject_project`, `deactivate_project` | A, nonce | `Project` | Status transitions |
| `resubmit_project` | H (owner), nonce | `Project` | Owner check against `project.owner` |
| `add_project_documents` | H (owner) or A, nonce | `ProjectDocuments` | Was unauthenticated before this change (finding F5) |
| `set_admin` | A, nonce | `Admin` | No event |
| `has_approved_project`, `get_project_methodology`, `get_project`, `list_projects`, `get_project_documents`, ... | P | | Read by `BondIssuer.issue_bond` |

### BondIssuer (`contracts/bond-issuer/src/lib.rs`)

| Function | Role | Writes | Cross-contract |
| --- | --- | --- | --- |
| `issue_bond` | A, nonce | `BondConfig`, `BondState`, `BondCount` | `ProjectRegistry.has_approved_project`, `get_project_methodology`, only if `ProjectRegistry` is set |
| `set_project_registry` | A, nonce | `ProjectRegistry` | The only mutable trust address in the suite. No event |
| `fund_redemption`, `mature_bond` | A, nonce | `BondState` | |
| `subscribe`, `transfer`, `redeem` | H, nonce | `BondState`, `HolderBalance` | `transfer` is also invoked by `DEXRouter.execute_purchase` under the seller's authorization |
| `set_admin` | A, nonce | `Admin` | Emits `admin_changed`. Nonce added in this change (F6) |
| `preview_subscribe`, `get_*`, `total_*` | P | | Read by `CouponEngine` and `CreditRetirement` |

### OracleConsumer (`contracts/oracle-consumer/src/lib.rs`)

| Function | Role | Writes | Notes |
| --- | --- | --- | --- |
| `register_provider`, `remove_provider` | A, nonce | `Provider`, `ProviderList` | |
| `set_signature_threshold`, `set_minimum_verifier_stake` | A, nonce | `SignatureThreshold`, `MinimumVerifierStake` | No events. Parameters that decide when a report becomes `Verified` |
| `verify_report` | A or qualifying provider, nonce | `Report` | The admin always counts as a qualifying verifier. A provider counts only when active, staked at or above the minimum, and not the report's author |
| `resolve_challenge`, `slash_provider` | A, nonce | `Challenge`, `Report`, `Provider` | `Rejected` slashes 10% of the provider's stake |
| `submit_report`, `challenge_report`, `add_stake`, `withdraw_stake` | H, nonce | `Report`, `Challenge`, `Provider` | |
| `set_admin` | A, nonce | `Admin` | Emits `admin_changed`. Nonce added in this change (F6) |
| `get_report`, `preview_slash`, `get_*` | P | | `get_report` is read by `CouponEngine.distribute_coupon` |

### CouponEngine (`contracts/coupon-engine/src/lib.rs`)

| Function | Role | Writes | Cross-contract |
| --- | --- | --- | --- |
| `register_bond` | A, nonce | `BondProject`, `BondCreditType` | `BondIssuer.get_bond` |
| `distribute_coupon`, `distribute_coupon_batch` | A, nonce | `PeriodInfo`, `PeriodBatchCursor`, `PeriodCount`, `UndistributedTotal`, holder accruals | `OracleConsumer.get_report`, `BondIssuer.total_subscribed`, `BondIssuer.get_holder_balance` |
| `sweep_undistributed` | A, nonce | `UndistributedTotal` | Resets the counter to zero and emits the amount. No value moves |
| `claim_credits` | H, nonce | holder accruals | Zeroes the caller's accrued balance |
| `consume_credits` | H (no nonce) | holder accruals | Debits an exact amount. Added in this change (F4); invoked by `CreditRetirement.retire_credits` under the holder's authorization |
| `set_admin` | A, nonce | `Admin` | Emits `admin_changed` |
| `accrued_credits`, `claimable_credit_details`, `get_*` | P | | |

Trust addresses `BondIssuerAddress` and `OracleConsumerAddress` are set once in the constructor and cannot be changed.

### DEXRouter (`contracts/dex-router/src/lib.rs`)

| Function | Role | Writes | Cross-contract |
| --- | --- | --- | --- |
| `clean_expired_orders` | A, nonce | `Order` | The admin's only power: expiring stale listings |
| `list_bond_tokens`, `cancel_listing`, `execute_purchase`, `deposit_quote`, `withdraw_quote` | H, nonce | `Order`, escrow balances | `execute_purchase` invokes `BondIssuer.transfer` for the seller |
| `set_admin` | A, nonce | `Admin` | Emits `admin_changed`. Nonce added in this change (F6) |

Trust addresses are constructor-fixed.

### CreditRetirement (`contracts/credit-retirement/src/lib.rs`)

| Function | Role | Writes | Cross-contract |
| --- | --- | --- | --- |
| `retire_credits` | H, nonce | `Retirement`, `RetirementCount`, `HolderRetirements`, `RetiredCredits`, `RetiredPerBond` | `BondIssuer.get_holder_balance`, `CouponEngine.accrued_credits`, `CouponEngine.consume_credits` |
| `set_admin` | A, nonce | `Admin` | Emits `admin_changed`. The admin has no other power in this contract |

Trust addresses are constructor-fixed.

### Governance (`contracts/governance/src/lib.rs`)

| Function | Role | Notes |
| --- | --- | --- |
| `add_to_allow_list`, `remove_from_allow_list` | S, nonce | A single signer can allow or disallow any (target, method) pair. No proposal or timelock |
| `propose` | S, nonce | Target/method must be allow-listed. `validate_proposal_callable` is a no-op |
| `vote_approve`, `vote_veto`, `cancel` | S, nonce | Approval count reaching `threshold` queues the proposal and starts the timelock |
| `execute` | any address, nonce | Requires `Queued` and elapsed timelock. Invokes `target.method(governance_address, ...args, execution_nonce)` |
| `get_*`, `is_signer` | P | |

## Trust graph

Every cross-contract call, with the direction of trust:

- `BondIssuer` reads `ProjectRegistry` (`has_approved_project`, `get_project_methodology`) inside `issue_bond`, when a registry address has been set.
- `CouponEngine` reads `OracleConsumer.get_report` and `BondIssuer.get_bond`, `total_subscribed`, `get_holder_balance`.
- `CreditRetirement` reads `BondIssuer.get_holder_balance` and `CouponEngine.accrued_credits`, and writes through `CouponEngine.consume_credits`.
- `DEXRouter` writes through `BondIssuer.transfer` (seller-authorized) and reads `BondIssuer.get_nonce`.
- `Governance` calls any allow-listed method on any contract whose admin it holds.

`OracleConsumer`, `ProjectRegistry` and `Governance` call nothing.

## Escalation-chain analyses

### E1. ProjectRegistry admin, and BondIssuer admin, over what may be issued

The registry admin decides which projects are `Approved`, and `issue_bond` refuses unapproved projects and methodology/credit-type mismatches. That check is conditional: `issue_bond` wraps it in `if let Some(registry)` and `BondIssuer.__constructor` never sets `ProjectRegistry`. A `BondIssuer` whose admin has not called `set_project_registry` issues bonds against any project id with no validation at all, and the same admin can point the contract at a different registry later. Neither the omission nor the swap produces an event.

Consequence: the bond-issuer admin can bypass the registry admin entirely, either by never linking a registry or by linking one they control.

Status: accepted for now, documented as F1 and F2 below. Making the registry mandatory changes deployment order and every existing bond-issuer test fixture, which is a product decision and belongs in its own change. When the admin is `Governance`, both `issue_bond` and `set_project_registry` already pass through a proposal and timelock, which is the intended mitigation.

### E2. OracleConsumer admin over CouponEngine payouts

Coupons are minted from `carbon_sequestered` in a `Verified` report. A report becomes `Verified` when `qualifying_verifier_count` reaches `SignatureThreshold`, and the admin is counted unconditionally. With the previous default threshold of 1, the oracle admin alone could verify any submitted report, and `docs/oracle-design.md` already described the default as 2. The constant now matches the documentation, so at least one independent, staked, non-author provider must co-sign.

Residual path: the oracle admin can still `set_signature_threshold(1)` (no event), or register a provider they control, stake it, and co-sign with it. Both are single-key when the admin is not `Governance`.

Status: threshold default fixed. Residual accepted; `set_signature_threshold` and `register_provider` are the kind of parameter changes the governance design in `docs/design/PARAMETER_GOVERNANCE.md` assigns to a slower track.

### E3. CouponEngine admin over holders' coupons

`distribute_coupon` takes the holder list from the admin. A holder omitted from the list receives nothing; their share stays in `UndistributedTotal`. The period is then marked distributed and cannot be run again. `sweep_undistributed` only resets the counter, so the admin cannot extract the value, but they can deny it.

Status: accepted with mitigation. The API's `reindex-holders` and `reconcile-holders` routes rebuild the holder list from chain events, and `coupon_distributed` publishes `holder_count`, so an incomplete list is observable. On-chain holder enumeration in `BondIssuer` would close it structurally.

### E4. CreditRetirement and CouponEngine over the same balance

Before this change, `retire_credits` recorded retirements in its own storage and never touched `CouponEngine`, while `claim_credits` zeroed `CouponEngine`'s balance and never consulted `CreditRetirement`. A holder could retire their full accrued balance (minting a certificate) and then claim the same balance again. `docs/coupon-accounting.md` rule 2 describes the opposite behaviour.

Status: fixed (F4). `retire_credits` now invokes `CouponEngine.consume_credits(holder, bond_id, amount)`, which the holder authorizes as a sub-invocation, before the certificate is minted. `consume_credits` is also callable directly by a holder, which only reduces the caller's own balance without a certificate. Regression tests: `test_retire_debits_coupon_ledger_and_blocks_double_spend` (credit-retirement) and `test_coupon_accounting_invariants` (integration).

### E5. DEXRouter and BondIssuer

The router moves bond tokens only through `BondIssuer.transfer` under the seller's own authorization, and its admin can only expire stale orders. No role in the router reaches any other contract's privileged surface.

Status: no escalation path.

### E6. ProjectRegistry document hashes

`add_project_documents` had no `require_auth` and no owner check: any address could replace the evidence list of any project. Project documents are what auditors and investors read when deciding to approve or subscribe.

Status: fixed (F5). The function now takes `caller` and `nonce`, requires the caller's authorization, and accepts only the project owner or the admin. Tests: `test_project_documents_owner_and_admin_only`.

### E7. Governance over every admin role

`Governance.execute` invokes `target.method(governance_address, ...args, execution_nonce)`. `set_admin` on `BondIssuer`, `OracleConsumer` and `DEXRouter` took only `(current_admin, new_admin)`, so a governance proposal to rotate those three admins would have failed at execution with an argument-count error. `docs/governance.md` already documented the three-argument form.

Status: fixed (F6). All six `set_admin` functions now take a trailing nonce. `test_governance_rotates_admin_on_every_contract` in `contracts/tests/src/lib.rs` hands every admin role to a `Governance` deployment and rotates each one again through a two-of-three, timelocked proposal. It then asserts that neither the original key nor governance itself keeps the role.

Remaining single-signer powers inside `Governance`: `add_to_allow_list` and `remove_from_allow_list` need one signer and no timelock, so one signer can disallow a method and block a queued proposal from executing, or allow a method that the rest of the council did not expect to see proposed. Proposals still need `threshold` approvals, so this is a liveness and surprise risk; it does not allow a takeover. Documented as F7.

### E8. Build-level coupling

`CouponEngine` linked the whole `OracleConsumer` contract crate for one `#[contracttype]` (`Report`). Under `stellar contract build` this duplicated `OracleConsumer`'s exported symbols inside `CouponEngine`'s wasm and the link failed, so the coupon engine could not be deployed from source. `Report` now lives in `nbbs-shared` and `OracleConsumer` re-exports it.

Status: fixed (F8).

## Findings

| # | Location | Finding | Status |
| --- | --- | --- | --- |
| F1 | `bond-issuer/src/lib.rs` `issue_bond`, `__constructor` | Registry validation is skipped when no registry is linked (fail-open) | Accepted; see E1 |
| F2 | `bond-issuer/src/lib.rs` `set_project_registry` | Only mutable trust address; single-key, no event, no timelock | Accepted; governance track |
| F3 | `oracle-consumer/src/lib.rs` `DEFAULT_SIGNATURE_THRESHOLD` | Default 1 let the admin alone verify reports, contradicting `docs/oracle-design.md` | Fixed: default 2 |
| F4 | `credit-retirement/src/lib.rs` `retire_credits`; `coupon-engine/src/lib.rs` `claim_credits` | Retire and claim spent the same accrued balance independently | Fixed: `consume_credits` |
| F5 | `project-registry/src/lib.rs` `add_project_documents` | Unauthenticated overwrite of any project's document hashes | Fixed: owner or admin, nonce |
| F6 | `set_admin` in bond-issuer, oracle-consumer, dex-router | No nonce parameter, so `Governance.execute` could not call it | Fixed: nonce added |
| F7 | `governance/src/lib.rs` `add_to_allow_list`, `remove_from_allow_list` | One signer, no timelock | Accepted; governance track |
| F8 | `coupon-engine/Cargo.toml` | Contract crate linked as a runtime dependency | Fixed: `Report` moved to `nbbs-shared` |
| F9 | all `set_admin` | Single-step transfer; a typo in `new_admin` bricks the contract | Accepted; two-step accept recommended |
| F10 | `oracle-consumer/src/lib.rs` `set_signature_threshold`, `set_minimum_verifier_stake`; `bond-issuer` `set_project_registry`; `project-registry` `set_admin` | No events, so parameter and role changes are invisible to indexers | Accepted; add events with the governance work |

## Is role granting governance-gated?

By code: no. Every `set_admin` is callable by the current admin alone, takes effect immediately, and `Governance` has no way to change its own signer set.

By configuration: yes, when every operational contract's admin is the `Governance` address, which `scripts/deploy-testnet.sh` does when `GOVERNANCE_ADDRESS` is provided. In that configuration each privileged call in the matrix above requires `threshold` signer approvals and the timelock, and `test_governance_rotates_admin_on_every_contract` proves the rotation path works for all six contracts. Deployments that leave a plain account as admin get none of this, and nothing on-chain distinguishes the two states except `get_admin()`.

Recommended follow-ups, in order: two-step admin transfer (F9); events on every parameter and trust-address change (F10); signer rotation inside `Governance` so the council can evolve without redeploying; making the registry link mandatory once existing fixtures are migrated (F1).
