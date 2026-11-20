# Contract Event Schemas

All Soroban contracts emit events via `env.events().publish()`. The first topic
is always the event name as a `Symbol`; remaining topics and the value tuple
carry the payload. Event names use `snake_case` consistently across the codebase.

Events are the authoritative audit trail for bond lifecycle, oracle reports,
governance actions, and marketplace activity. Indexers and the API layer should
consume these events to build user-facing history views.

## BondIssuer

| Event | Topics | Payload |
|---|---|---|
| `admin_changed` | — | `(current_admin: Address, new_admin: Address)` |
| `bond_issued` | — | `(bond_id: u64, project_id: BytesN<32>)` |
| `subscribed` | — | `(bond_id: u64, investor: Address, amount: i128)` |
| `transferred` | — | `(bond_id: u64, from: Address, to: Address, amount: i128)` |
| `redemption_funded` | — | `(bond_id: u64, caller: Address, amount: i128)` |
| `redeemed` | — | `(bond_id: u64, holder: Address, amount: i128, payout: i128)` |
| `bond_matured` | — | `(bond_id: u64,)` |

## CouponEngine

| Event | Topics | Payload |
|---|---|---|
| `admin_changed` | — | `(current_admin: Address, new_admin: Address)` |
| `bond_registered` | — | `(bond_id: u64, project_id: BytesN<32>)` |
| `coupon_distributed` | — | `(bond_id: u64, period_index: u32, total_holder_credits: i128, holder_count: u32)` |
| `credits_claimed` | — | `(bond_id: u64, caller: Address, accrued: i128)` |
| `undistributed_swept` | — | `(bond_id: u64, total: i128)` |

## OracleConsumer

| Event | Topics | Payload |
|---|---|---|
| `admin_changed` | — | `(current_admin: Address, new_admin: Address)` |
| `provider_registered` | — | `(provider: Address,)` |
| `provider_removed` | — | `(provider: Address,)` |
| `report_submitted` | — | `(report_id: u64, provider: Address, project_id: BytesN<32>)` |
| `report_verified` | — | `(report_id: u64,)` |
| `report_challenged` | — | `(report_id: u64, challenger: Address)` |
| `challenge_resolved` | — | `(report_id: u64,)` |
| `stake_added` | — | `(provider: Address, amount: i128)` |
| `stake_withdrawn` | — | `(provider: Address, amount: i128)` |
| `provider_slashed` | — | `(provider: Address, penalty: i128, remaining_stake: i128, is_active: bool)` |

## DEXRouter

| Event | Topics | Payload |
|---|---|---|
| `admin_changed` | — | `(current_admin: Address, new_admin: Address)` |
| `order_listed` | — | `(order_id: u64, seller: Address, bond_id: u64, amount: i128, price_per_token: i128)` |
| `order_cancelled` | — | `(order_id: u64, caller: Address)` |
| `order_filled` | — | `(order_id: u64, buyer: Address, filled_amount: i128, total_cost: i128)` |
| `quote_deposited` | — | `(caller: Address, quote_asset: Address, amount: i128)` |
| `quote_withdrawn` | — | `(caller: Address, quote_asset: Address, amount: i128)` |
| `expired_orders_cleaned` | — | `(cleaned: u32, next_start_id: u64)` |

## ProjectRegistry

| Event | Topics | Payload |
|---|---|---|
| `admin_changed` | — | `(current_admin: Address, new_admin: Address)` |
| `project_registered` | — | `(project_id: u64, owner: Address, methodology: Symbol, country: Symbol)` |
| `project_approved` | — | `(project_id: u64, admin: Address)` |
| `project_rejected` | — | `(project_id: u64, admin: Address)` |

## CreditRetirement

| Event | Topics | Payload |
|---|---|---|
| `admin_changed` | — | `(current_admin: Address, new_admin: Address)` |
| `credits_retired` | — | `(holder: Address, amount: i128, credit_type: CreditType)` |

## Governance

| Event | Topics | Payload |
|---|---|---|
| `method_allowed` | — | `(target: Address, method: Symbol)` |
| `method_disallowed` | — | `(target: Address, method: Symbol)` |
| `proposal_created` | — | `(proposal_id: u64, target: Address, caller: Address)` |
| `vote_cast` | — | `(proposal_id: u64, caller: Address, status: u32)` |
| `proposal_rejected` | — | `(proposal_id: u64, caller: Address)` |
| `proposal_cancelled` | — | `(proposal_id: u64, caller: Address)` |
| `proposal_executed` | — | `(proposal_id: u64, target: Address)` |

## Event Retention and Indexing

- Events are stored on-chain indefinitely by the Stellar network; no off-chain
  retention policy is needed for the raw data.
- The API layer should maintain an indexed view (database or cache) for fast
  user-facing queries. At minimum, bond history and project history views
  should be queryable by the API.
- Indexers should process events in ledger order and handle replays idempotently
  (e.g., by deduplicating on `(ledger, event_id)`).
- Schema changes to event payloads require a contract upgrade; consumers should
  tolerate missing or extra fields via defensive decoding.
