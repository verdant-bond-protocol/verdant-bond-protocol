# Secondary-Market Order-Matching Threat Model (#185)

## Execution model and assets at risk

The current secondary market is a fixed-price, escrow-backed order book in
`DEXRouter`, not a reserve-based AMM. A listed order exposes its seller, bond
quantity, quote asset, and ask before execution. A purchase can move bond tokens
and quote balances, but it cannot change the seller's ask or a pool reserve.
The primary risks are therefore transaction ordering, order depletion, and
revealing a buyer's size—not the reserve-price sandwich used against a
constant-product AMM.

## Soroban/Stellar-specific attack surfaces

1. **Mempool visibility and same-ledger ordering.** Submitted Soroban
   transactions are visible before ledger inclusion. A competing transaction
   may be ordered ahead of a purchase and fill some or all of its public
   listing.
2. **Public ledger state and events.** Once a listing or purchase is included,
   its parameters and emitted events are public. Repeated purchases can expose
   the buyer's remaining size to transactions targeting later ledgers.
3. **Oracle/report timing.** An oracle update and a purchase can be submitted
   in the same ledger. This router does not use an AMM spot price, but any
   downstream value estimate that combines a report with the order book must
   not treat the latest fill as an independently verified fair value.
4. **Commit spam.** A caller could publish commitments and withhold reveals to
   consume matching attention or create uncertainty about pending demand.
   Unbonded commitments make this cheap.
5. **Replay or cross-order substitution.** A reveal that is not bound to its
   buyer, order, price cap, amount, and salt could be copied or redirected.

Stellar transaction sequence numbers prevent replay of a signed account
transaction, but do not conceal its contents, guarantee transaction ordering,
or prevent another account from submitting a competing purchase.

## Mitigation and limits

`commit_purchase` locks 1,000 quote-asset minor units. The buyer waits at least
one ledger, then reveals the SHA-256 digest of the canonical XDR tuple
`(buyer, order_id, max_price, amount, salt)`. A valid reveal settles at the
seller's immutable posted ask and refunds the bond atomically. A commitment
that is not revealed within twenty ledgers can be forfeited permissionlessly;
its bond is moved to the contract's per-asset penalty reserve. A mismatched or
premature reveal changes no state.

The listing ask is also a hard execution-price ceiling: execution does not
reprice against an AMM reserve or an oracle spot observation. Consequently, a
transaction ordered before a committed purchase can at most compete for the
fixed-price inventory; it cannot worsen the committed buyer's execution price.
The mitigation does not guarantee fill priority, hide public sell listings, or
protect users who choose the legacy immediate `execute_purchase` entry point.
Integrators handling price-sensitive or large orders should use the
commit-reveal entry points and set a conservative `max_price`.

The fixed bond is denominated in quote-asset minor units. Deployments must use
quote assets whose minor-unit scale makes 1,000 units economically meaningful;
it is not an oracle-valued anti-spam guarantee for arbitrary assets. The
penalty reserve is accounting state, not a user withdrawal balance.

## Test evidence

DEX tests cover a successful delayed reveal and refund, rejection of early and
incorrect reveals without releasing the bond, and permissionless forfeiture
after the reveal deadline. Existing settlement tests assert that the buyer
never pays above the listing ask and that order fills conserve the posted
quote amount.
