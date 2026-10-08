# Versioned registry equivalence and coupon audit

The coupon engine stores a complete immutable equivalence table for each version.
Each entry binds a registry-qualified methodology symbol from the verified oracle
report (for example, `verra_vcs` or `gold_standard`) to a positive rational factor.
Governance must provision symbols that uniquely identify the registry and
methodology combination; the report format already carries this symbol, so no
off-chain registry inference is performed. Factors are methodology judgments,
not scientifically asserted constants supplied by the protocol.

## Governance

The existing engine administrator calls `set_equivalence_governance` once to bind
the governance contract address. Only authenticated calls from that address can
invoke `publish_equivalence`. Bind the deployed governance contract and allow-list
`publish_equivalence` through its existing proposal mechanism, selecting the
appropriate risk track and timelock. The authority cannot be replaced by later
engine-admin rotation. Publishing supplies the expected current version, a full
table, and a nonzero hash of the governance rationale/evidence. A stale queued
proposal is rejected instead of silently superseding a later table.

Tables contain 1 to 32 unique methodology symbols; numerators and denominators
must be positive and at most 1000000000. An update creates version v+1 and retains
version v, its factors, publication timestamp, governance address, and rationale
hash. Events emit the entire new table. Removed methodologies fail closed for new
coupons; their old tables and coupon records remain readable.

## Calculation and reproducibility

For a carbon-bearing coupon, normalization is
`normalized_carbon = floor(raw_carbon * numerator / denominator)`, using checked
integer arithmetic. The existing credit conversion then computes
`carbon_pool = floor(normalized_carbon / CREDIT_DIVISOR) * CREDIT_MINOR_UNITS`.
Normalization occurs before the existing staleness discount, forward true-ups,
and covenant multiplier. Carbon and biodiversity pools remain separate: carbon
equivalence never converts biodiversity into carbon. Biodiversity-only coupons
record that carbon conversion was not applied.

Before the first table is published, version 0 explicitly denotes the legacy
identity factor 1/1. Every newly calculated coupon, including version 0, records
its table version, report, methodology, raw and normalized quantity, applied
factor, staleness discount, signed true-up amount, covenant multiplier, final
typed pools, issuer balance checkpoint, and subscribed supply. Version 0 preserves
legacy issuance while exposing its assumption in the audit record. Once a table
exists, an unlisted carbon methodology raises `UnknownEquivalence`.

The first successful batch pins the entire calculation and ownership checkpoint.
The latest calculation also shares the bond's instance lifetime, keeping an
ongoing cycle stable when its persistent history entry requires restoration.
Later batches reuse its version, pools, and holder balances, even if governance
publishes a new table or tokens transfer between batches. Conversion changes
apply only to subsequently started coupons. Failed batches roll back their audit
record and any true-up or covenant writes. New storage uses separate namespaced
keys and preserves the existing PeriodInfo layout.

`get_equivalence_table(version)` retrieves historical factors;
`get_coupon_calculation(bond, period)` retrieves the calculation snapshot;
`replay_coupon_conversion(bond, period)` replays its normalization. To reproduce
each payout, calculate the two typed pools in the recorded operation order, then
apply `floor(pool * checkpoint_holder_balance / recorded_subscribed_supply)`
for each paid holder, retaining residual rounding dust as undistributed credits.
The existing issuer checkpoint queries expose the required historical balances.
Rationale documents and verified oracle reports explain the registry judgment
and source observation independently of the live equivalence version.

Deploy an upgrade between coupon cycles: records created before this feature are
not retroactively backfilled, and an already-started legacy batch has no new
calculation snapshot; resuming such a batch fails closed rather than deriving
new terms from today's table. Historical persistent entries remain subject to normal
Soroban archival/restoration; retaining old versions never overwrites them.
