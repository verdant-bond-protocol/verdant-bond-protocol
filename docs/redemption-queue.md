# Principal redemption queue

`request_redemption(holder, bond_id, amount, request_key, nonce)` reserves matured
positions and returns a per-bond queue id. Submit a stable 32-byte request key for
retries. Repeating the same holder/bond/key/amount returns the original id without
consuming another nonce or adding another entry, even after settlement. Reusing
the key for another amount fails. A new key needs the current authenticated nonce
and unreserved positions. Reserved positions cannot be queued again.

Requests are ordered by accepted ledger sequence, then increasing queue id within
that ledger. No price, fee, keeper, or caller-selected priority affects processing.
Stellar validators determine transaction order within a ledger; this contract
does not eliminate validator ordering of same-ledger submissions. Once accepted,
a request cannot be moved or skipped.

Anyone may call `process_redemptions(bond_id, limit)`. Each call visits at most 50
entries, starting at the head. Payout is limited to the minimum of the funded
principal pool and unused cycle allowance, rounded down to whole positions. An
oversized head receives partial payouts and retains its place until complete.
Principal below one position remains funded. Empty pools or exhausted budgets
leave the queue intact without burning positions. The result counts completed
requests; partial progress appears in `remaining` and `redemption_processed` events.

The default budget is 1,000,000,000 principal minor units per 720 ledgers (roughly
one hour with five-second ledgers). Cycles are `ledger_sequence / ledgers_per_cycle`;
unused allowance does not carry forward. Governance may call
`configure_redemption_budget` before the first request, using issuer admin authority
and nonce. The budget must cover at least one position. Configuration freezes
after any request, preventing budget/cycle resets from bypassing the cap. Choose
the deployment's principal precision and liquidity replenishment budget first.

The legacy `redeem` uses the same queue and budget. It succeeds synchronously only
when no request is waiting and the entire payout fits funding and allowance.
Otherwise clients must use `request_redemption`; direct redemption cannot jump
pending requests. Position burning, balance checkpoints, outstanding liability,
and principal-pool debits share the issuer's original settlement logic.

The principal pool remains the administrator's funded accounting balance; this
change does not introduce an external token withdrawal rail. Events reconcile
the existing principal settlement. Head/tail, reservations, budget usage and
idempotency metadata share the contract instance lifetime so expiry cannot reset
FIFO order or replay guards. Request bodies extend persistent TTL to the network
maximum on use. Operators must maintain/restore archived request bodies; a missing
queued request fails instead of skipping it. Replay metadata consumes instance
storage proportional to accepted requests and must be included in deployment
capacity planning; never prune it while its positions or retry keys remain valid.
