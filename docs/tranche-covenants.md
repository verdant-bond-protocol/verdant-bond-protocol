# Automatic tranche covenant terms

The coupon engine accepts one authenticated `configure_covenant` call for a
registered bond before its first coupon starts. Terms cannot be overwritten.
Unconfigured bonds retain their existing behavior. Two inputs are evaluated from
contract state during coupon execution: the verified report's native carbon
quantity, and the bond issuer's funded redemption pool. Neither input is supplied
as a caller assertion. This implementation uses principal funding as its on-chain
financial covenant; an independently custody-backed operator bond would require
an additional signal contract.

A cycle is breached when either `performance < min_performance` or
`redemption_funding < min_redemption_funding`. Equality meets the threshold. The
transition is a pure function of these observations, immutable configuration,
and previous state:

* A breached cycle increments the consecutive breach count and resets the clean
  count. At `breach_cycles` consecutive breaches, the tranche steps down.
* A clean cycle increments the consecutive clean count and resets the breach
  count. At `recovery_cycles` consecutive clean cycles, normal terms resume.
* Opposite observations below their configured consecutive threshold leave the
  current terms unchanged. Counts saturate at the configured thresholds.

Normal coupons have a 10000 basis-point multiplier. Stepped-down coupons apply
`stepped_coupon_bps` (0 through 9999) independently to carbon and biodiversity
pools, rounding down. The transition takes effect on the triggering cycle.
Evaluation occurs after report verification, dispute/staleness checks, and
performance anomaly safeguards; paused or rejected reports do not count as
successful cycles. The existing authorized coupon executor advances the cycle;
no separate administrative step-down or step-up transaction is required.

Configured bonds must process periods consecutively from zero. Reporting windows
must advance without overlap, preventing reuse of one observation to satisfy
hysteresis. Each cycle stores the report ID, observed signals, breach outcome,
resulting counters, multiplier, and final credit pools. Batched distribution
reuses that snapshot: funding changes between batches cannot change terms or
count the same cycle twice. A failed distribution rolls back the transition.
Configuration, running counters, and the latest cycle share the bond's instance
lifetime; historical cycle records use persistent storage and can be restored.
`get_covenant`, `get_covenant_state`, and `get_covenant_cycle` expose the terms and
history. Events record configuration and each automatic evaluation.
