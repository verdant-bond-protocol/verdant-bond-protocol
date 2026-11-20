# Parameter Governance Design

Status: design. The existing `Governance` contract (N-of-M signers, allow-listed methods, one timelock) is the execution layer this design extends. Nothing here is implemented yet except where a section says so.

## What exists today

`contracts/governance/src/lib.rs` implements a signer council: a fixed signer set and threshold from the constructor, an allow-list of (target, method) pairs, proposals that queue when `threshold` approvals arrive, a single `timelock_seconds` (default 172 800, 48 hours), veto, cancel, and `execute`, which anyone may call once the timelock has elapsed. Execution invokes `target.method(governance_address, ...args, execution_nonce)`, so any admin method whose signature is `(caller, ..., nonce)` can be driven by governance, and every `set_admin` now follows that shape (see `access-control-review.md`, F6).

Gaps this design closes:

- One timelock and one threshold for everything, from tuning a staleness window to swapping the project registry.
- No token-weighted voting, so bond holders have no say in changes to the coupons they are paid.
- No emergency path: a discovered oracle flaw waits 48 hours like everything else.
- Single-signer allow-list edits (`add_to_allow_list`, `remove_from_allow_list`) with no delay.
- No signer rotation.

## Parameter inventory and risk tiers

Every mutable parameter in the suite, with the tier that decides how it may change.

| Parameter | Where | Tier |
| --- | --- | --- |
| Oracle report staleness window used by the API and frontend | `api` config | 0 |
| `MinimumVerifierStake` | `OracleConsumer.set_minimum_verifier_stake` | 1 |
| `SignatureThreshold` | `OracleConsumer.set_signature_threshold` | 1 |
| Provider registration and removal | `OracleConsumer.register_provider`, `remove_provider` | 1 |
| Slash penalty (`SLASH_PENALTY_PPM`), challenge window, credit conversion (`CREDIT_DIVISOR`, biodiversity rates) | constants today | 2 once exposed |
| Methodology and credit-type compatibility (`nbbs_shared::methodology`) | constants today | 2 once exposed |
| AMM price-deviation cap, quote-asset list | `api` marketplace config today | 1 once on-chain |
| Project approval, rejection, deactivation | `ProjectRegistry` | 1 |
| Trust addresses: `BondIssuer.set_project_registry` | `BondIssuer` | 2 |
| Admin rotation on any contract | `set_admin` | 2 |
| Governance's own signer set, threshold, timelocks | `Governance` | 3 |
| Pause | not implemented | E |

## Governance tracks

| Track | Used for | Who votes | Approval | Timelock | Veto |
| --- | --- | --- | --- | --- | --- |
| 0 Routine | Off-chain and operational tuning with no financial effect | Signer council | 2 of N | 24 h | 1 signer |
| 1 Economic | Parameters that change who gets paid or when a report counts (tiers marked 1) | Signer council plus bond-holder snapshot vote | Council 3 of N and holders: quorum 10% of subscribed supply, simple majority | 72 h | 2 signers, or 20% of snapshot weight |
| 2 Structural | Trust addresses, admin rotation, constants once exposed, contract upgrades | Council supermajority plus holders | Council 4 of N and holders: quorum 20%, two-thirds majority | 7 days | 2 signers, or 20% of snapshot weight |
| 3 Meta | Signer set, thresholds, timelocks of the governance contract itself | Council supermajority plus holders | Council 4 of N and holders: quorum 25%, two-thirds | 14 days | 3 signers |
| E Emergency pause | Halt `distribute_coupon`, `verify_report`, `execute_purchase` | Emergency council (subset of signers, each with a distinct organisation) | 4 of N, at least 3 organisations | 1 h | none; unpause is a Track 1 proposal |

Track assignment is per (target, method) and is itself a Track 3 decision. `Governance` stores it in place of today's boolean allow-list: `AllowList(target, method) -> Track`.

Timelock counts from the moment the last required approval arrives, exactly as `queued_at` works today, so a proposal cannot be queued early and executed the instant its last vote lands.

## Vote weight and the flash-loan problem

Council votes are one signer, one vote, as now.

Holder votes are weighted by bond tokens and the weight is read from a snapshot taken before the proposal existed. The rule: proposal `p` created in ledger `L` uses each holder's balance as of ledger `L - 1`. Tokens acquired in ledger `L` or later, including anything bought or borrowed after seeing the proposal, carry no weight for `p`.

Soroban contracts cannot read historical ledger state, so `BondIssuer` has to keep it. The mechanism is the checkpoint pattern used by vote-enabled ERC-20 tokens:

- `BondIssuer` stores, per holder, a vector of `(ledger_sequence, balance)` checkpoints and appends one on every `subscribe`, `transfer` and `redeem`. Per bond it stores a vector of `(ledger_sequence, total_subscribed)`.
- `BondIssuer.balance_at(holder, bond_id, ledger)` and `subscribed_at(bond_id, ledger)` binary-search the vectors. Reads are public.
- `Governance.propose` records `snapshot_ledger = current_ledger - 1` on the proposal. `vote_holder(caller, proposal_id, nonce)` reads `balance_at(caller, bond, snapshot_ledger)` for every bond in the proposal's scope and rejects zero weight.
- Quorum is measured against `subscribed_at(bond, snapshot_ledger)`, so newly issued supply cannot dilute a vote in progress.

Why this defeats a flash loan: a loan taken inside a transaction exists only in that ledger. The snapshot is at least one ledger earlier, and `propose` and `vote_holder` reject any call whose `snapshot_ledger >= current_ledger`. The borrower's snapshot balance is whatever they held before the loan, which is what they could vote with anyway.

Additional guard: `propose` on Tracks 1 to 3 requires the proposer to hold a minimum snapshot weight (0.1% of subscribed supply) or to be a signer, which removes zero-cost proposal spam without requiring a token to propose.

Test the acceptance criterion asks for, to be written with the implementation: in one transaction a test account subscribes to 60% of a bond's supply, casts a holder vote on a Track 1 proposal created in the previous ledger, and transfers the tokens away. The vote must be rejected with `NoSnapshotWeight`, the proposal's `holder_weight_for` must be unchanged, and a second proposal created after the transfer must also show zero weight for that account. A control case shows the same account holding for one ledger before the proposal is created does carry weight.

## Emergency pause

Each pausable contract gains `set_paused(caller, paused: bool, nonce)` gated by `require_admin`, and its pausable entry points check the flag. `Governance` gains `emergency_pause(caller, target, nonce)`, which is a Track E proposal: approvals from the emergency council members count, and after one hour any address may execute it. The higher threshold (4 of N with an organisation-diversity rule) is the check against a small group using the short delay to freeze the protocol for advantage.

Unpausing is deliberately slower: a Track 1 proposal, so the community sees the reason for the pause and the fix before payments resume. A pause does not stop `claim_credits` or `retire_credits`; holders keep access to what they have already accrued.

## Allow-list and signer rotation

`add_to_allow_list` and `remove_from_allow_list` move from single-signer calls to Track 3 proposals. During migration, the existing allow-list is copied into the new `AllowList(target, method) -> Track` map with every entry at Track 2, then re-tiered by proposal.

`add_signer`, `remove_signer` and `set_threshold` are added to `Governance` as Track 3 targets of itself, with the constraint that `threshold` stays within `1..=signers.len()` after every change and that the emergency council remains a subset of the signers.

## Migration order

1. Deploy the new `Governance` with the current signers and thresholds.
2. Ship the `BondIssuer` checkpoint storage (additive; existing balances get an initial checkpoint on their next movement, and `balance_at` falls back to the live balance when no checkpoint predates the requested ledger).
3. Rotate each operational contract's admin to the new `Governance` through the old one (Track 2 on the old contract, one proposal per contract, as `test_governance_rotates_admin_on_every_contract` already exercises).
4. Enable holder voting on Tracks 1 to 3 once the checkpoint history covers at least one full coupon period.

## Non-goals

Delegation, off-chain signalling votes, and a governance token separate from bond holdings. Bond holders are the party paid by the parameters in scope, which is the reason they and the council are the two electorates.
