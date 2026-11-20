# Secondary-Market Order Replay Protection

Scope: the `dex-router` contract, which runs the secondary market for bond
tranche tokens (`list_bond_tokens`, `execute_purchase`, `cancel_listing`,
`deposit_quote`, `withdraw_quote`, `clean_expired_orders`).

This document is the authorization/replay-protection model for that market and
maps directly to the hardening requirements in issue #215.

## 1. How orders are authorized

The dex-router does **not** use an off-chain "sign an order, relay it on-chain"
scheme. Every state-changing entrypoint is a direct contract invocation whose
caller is authenticated with Soroban **native authorization**
(`Address::require_auth`). This is deliberate: native auth is strictly stronger
than a hand-rolled off-chain signature scheme because the host binds each
authorization, not the application.

### 1.1 Domain separation is provided by the host

When a caller authorizes an invocation, the Soroban host verifies a signature
over `HashIdPreimage::SorobanAuthorization`, whose preimage includes:

- **`network_id`** — the SHA-256 of the network passphrase. A signature produced
  for **testnet cannot be replayed on mainnet** (or any other network), because
  the signed hash differs.
- **the invocation** — the **target contract address**, the function symbol, and
  the exact arguments. A signature authorizing a call to **one dex-router
  instance cannot be replayed against a different contract instance**, nor
  repurposed for a different function or different arguments.
- **`nonce` + `signature_expiration_ledger`** — a host-tracked auth nonce that is
  consumed on use, so a captured authorization payload cannot be replayed on the
  same contract/network either.

This satisfies the domain-separation requirement (contract address + network
identifier) at the platform layer: it is impossible to construct an order
authorization on one network/contract and have it accepted on another.

### 1.2 Application-level per-account nonce

On top of host auth, every entrypoint takes an explicit `nonce: u64` argument
that must equal the caller's current stored nonce (`DataKey::Nonce(addr)`); it is
then incremented (`get_nonce`/`set_nonce`). This gives the protocol an
**explicit, queryable, strictly-increasing per-account sequence** (`get_nonce`
is a public view) that:

- rejects any call carrying a stale or skipped nonce (`DEXError::InvalidNonce`),
  so a duplicated/reordered submission is refused before doing any work;
- is shared across all of an account's actions, so nonces cannot be "banked" per
  function and replayed out of order.

## 2. Partial-fill accounting (no stale-state replay)

Remaining fillable size is tracked **on-chain per order ID**, not re-derived from
signatures:

- `execute_purchase(order_id, amount, ...)` requires `amount <= order.amount`
  (the *remaining* size), otherwise `DEXError::InsufficientBalance`.
- On a partial fill it sets `status = PartiallyFilled` and decrements
  `order.amount -= amount`; on a complete fill it sets `status = Filled`.
- Any subsequent purchase against a `Filled` (or `Cancelled`/`Expired`) order is
  rejected with `DEXError::OrderAlreadyFilled`.

Consequences:

- **A fully-filled order cannot be re-executed** — its status is `Filled`.
- **A partially-filled order cannot be over-filled** — only the decremented
  remaining amount is purchasable; requesting more than remains reverts.

Because the remaining amount lives in contract storage and is decremented
atomically inside the same invocation that transfers tokens, there is no window
in which the "same" order can be filled twice for the same units.

## 3. Requirements → where they are enforced

| #215 acceptance criterion | Enforcement |
|---|---|
| Signed payload includes contract address + network identifier (domain separation) | Soroban native auth preimage binds `network_id` + target contract + args (§1.1) |
| Partial fills tracked per order ID with remaining amount decremented | `order.amount` decrement + `status` transitions (§2) |
| A testnet signature cannot be replayed on mainnet / another contract | Host `network_id` + invocation binding (§1.1); see test-module note in `dex-router` |
| Replaying a fully-filled order / over-filling a partial order is rejected | `OrderAlreadyFilled` / `InsufficientBalance` guards, covered by tests (§2) |

## 4. Tests

Executable regression tests live in `contracts/dex-router/src/lib.rs` (`mod
test`):

- `test_filled_order_cannot_be_repurchased`
- `test_partial_order_cannot_be_overfilled`
- `test_partial_fills_decrement_remaining_to_filled`
- `test_stale_nonce_replay_rejected`
- `test_nonce_is_per_account_and_monotonic`

Cross-network / cross-contract replay is enforced by the Soroban host's auth
preimage (§1.1) rather than by contract code, so it cannot be exercised in the
mock-auth unit environment (`mock_all_auths` bypasses signature verification).
It is asserted here by construction and documented so that **any future move to
an off-chain relayed-order model must re-introduce the same domain separation
explicitly** — contract address, network id, and a per-order nonce in the signed
payload — rather than relying on a bare order signature.
