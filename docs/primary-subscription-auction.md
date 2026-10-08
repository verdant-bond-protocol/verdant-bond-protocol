# Primary tranche subscription auction

`issue_auction` atomically issues a bond and reserves its primary supply for an
auction. The legacy `subscribe` entry point rejects that bond permanently.
The issuer's authenticated entitlement authority grants each admitted wallet an
opaque, nonzero KYC identity commitment before the announced open ledger. The
authority must use the same commitment for all wallets of the same verified
person; wallet owners cannot choose or replace it. Admission is immutable after
the open ledger. This is the trust boundary of sybil resistance, not a claim that
wallet addresses can establish unique human identities.

Orders escrow actual settlement tokens at `face_value * requested_units` during
`open_ledger <= current_ledger < cutoff_ledger`. Repeated orders add to the same
wallet's commitment. Requests across every admitted wallet sharing an identity
must together remain at or below `identity_cap`, expressed in bond units. There
is no early allocation, price bidding, or arrival-order priority. Committing at
the end of the window gives no allocation advantage. The ledger cutoff excludes
late orders, including transactions executed exactly at cutoff.

## Formal allocation

Let S be available tranche supply, d_i the sum of committed bond units for KYC
identity i, and D the sum of d_i. Orders cannot be canceled after commitment.
Identity admission and commitments are fixed at cutoff.

* If D < S (undersubscribed) or D = S (exact fill), allocate d_i to each identity.
  Unsubscribed supply remains unissued and this completed auction cannot reopen.
* If D > S, first allocate a_i = floor(S * d_i / D). Let r_i = (S * d_i) mod D.
  Assign each of the S - sum(a_i) remaining units to an identity with the largest
  remainder, breaking ties by ascending identity commitment bytes. Each identity
  receives at most one remainder unit.
* Within an identity, apply the same largest-remainder rule to its wallets using
  the identity's allocation as capacity and wallet requests as demand. Break
  wallet ties by canonical ascending Soroban Address order. Splitting wallets
  cannot increase the identity's total allocation or its cap.

Settlement sorts its own on-chain orders and takes no allocation input from an
auctioneer. The result is deterministic regardless of transaction arrival order.
All arithmetic is checked; per-identity demand is bounded by MAX_SUPPLY.
The contract admits at most 32 wallets before opening, bounding the work of a
single atomic settlement transaction. This explicit capacity limit should be
evaluated against network resource budgets before deployment; deployments needing
larger participation require a separately designed settlement protocol.

## Settlement and audit

Anyone may invoke settlement at or after cutoff. In one transaction it records
allocations, updates issuer balances and supply checkpoints, returns
`(requested - allocated) * face_value` tokens to each committing wallet, and
transfers accepted capital to the configured treasury. A failed token transfer
rolls back all refunds, balances, checkpoints, and the settlement marker.
Settlement cannot run twice. The auction-only issuance marker shares the bond
configuration's instance lifetime, so archiving the persistent order book cannot
reopen the legacy subscription path. The final order records retain identity,
requested units, allocated units, and refunded capital; events expose entitlement,
commitment, and settlement provenance. If the tranche has matured or ceased to be
active before settlement, it allocates zero and refunds all committed capital.

The entitlement authority and token configuration are deployment responsibilities.
Identity commitments should be derived from the existing compliance/KYC process,
without putting personal identity data on-chain. Admission is deliberately sealed
for this issuance so later entitlement edits cannot change its historical result.
