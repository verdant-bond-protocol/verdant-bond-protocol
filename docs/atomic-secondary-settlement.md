# Atomic secondary-market settlement

`DEXRouter.execute_purchase` is the single escrow invocation for both quote
payment accounting and issuer position transfer. Clients must submit one Soroban
transaction invoking it. Never perform an independent quote payment followed by
a separate issuer transfer. Both buyer and seller must authorize the full purchase
invocation, including its nested issuer transfer; an old listing signature does
not authorize a future fill. Missing authorization fails the transaction.

Before either leg changes balances, settlement checks the buyer nonce, order
status/expiry, parties, requested size, price cap, seller escrow, funded quote
balance, seller quote arithmetic, issuer nonce, and the issuer's `check_transfer`.
The issuer preflight and actual transfer share validation for bond existence,
active status, maturity, source positions, destination arithmetic, and compliance
blocks on either participant. The issuer administrator controls
`set_transfer_blocked` with authentication and nonce protection. Existing off-chain
compliance review still determines which participants the issuer blocks.

The router then finalizes quote balances, nonce, escrow, and order state before
the issuer call. Partial fills decrement the remaining order amount once; full
fills set it to zero. The issuer transfer is an uncaught contract invocation:
any failure reverts every earlier write in the transaction, including quote
debits, credits, order updates, market observations and issuer state. The router
must never catch a failed position transfer and return success.

This uses the router's existing funded quote-accounting balance and seller escrow
reservation. It does not add an independent external payment rail or turn listing
authorization into future transfer authority. Sender positions are revalidated
at settlement, so depleted or restricted positions cannot leave a buyer charged.
