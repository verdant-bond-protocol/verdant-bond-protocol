# Oracle-fed performance validation for coupon math (#186)

Coupon payouts are driven by verified oracle reports (`carbon_sequestered`,
biodiversity metrics) in the coupon engine. Because the chain cannot verify
real-world ecological performance, `contracts/coupon-engine` applies
structural heuristics to bound implausible values **before** any coupon math
runs on them. The bounds are deliberately asymmetric: manipulated spikes are
rejected hard, while genuine catastrophic collapses are possible in nature and
therefore routed to review instead of being silently clamped.

## Thresholds and rationale

| Constant | Value | Rationale |
| --- | --- | --- |
| `MAX_PERFORMANCE_INCREASE_BPS` | 10 000 (+100% per period) | Nature-based carbon sinks grow slowly; a doubling within a single reporting period (e.g. 10% → 400%) is consistent with a fabricated or erroneous feed, not with sequestration reality. |
| `MAX_PERFORMANCE_DECREASE_BPS` | 9 000 (−90% per period) | Genuine catastrophic events (wildfire destroying a sink overnight) can legitimately crater a report. Drops up to −90% are accepted so real events still pay out; anything steeper is also consistent with a manipulated feed, so it is flagged for review instead of being trusted or clamped. |
| `MIN_PERFORMANCE_ATTESTATIONS` | 2 | At least two independent qualifying verifiers must have attested a report before it may drive payouts. This is a coupon-level backstop on top of the oracle consumer's verification threshold (docs/oracle-design.md, "Multi-Source Verification Threshold"); it is admin-tunable via `set_min_performance_attestations`. |
| `TRAILING_HISTORY_PERIODS` | 8 | Rate-of-change is checked against the most recent accepted observation. Eight periods are retained so operators can audit recent history; only the latest entry drives the bound. |

## How validation runs in `distribute_coupon_batch`

1. Report must be `Verified` (oracle consumer) and belong to the bond's project.
2. If `PerformanceFlag(bond)` is set, distribution fails with
   `PerformanceFlagged` until an admin clears the flag — the pause is explicit,
   nothing is silently clamped.
3. `get_verification_count(report)` (cross-call to the oracle consumer) must be
   at least `MIN_PERFORMANCE_ATTESTATIONS`, else `InsufficientAttestations`.
4. Rate-of-change: compared against the previous accepted observation for the
   bond (`PerformanceHistory`). The first accepted report is the baseline.
   A bound violation sets the flag, publishes the `performance_flagged`
   event, and rejects the distribution.

Accepted observations are appended to the trailing history after a complete
distribution batch, so each check always compares against the last applied
performance.

## Flag lifecycle

1. Bound violation → `PerformanceFlag{ report_id, reason: Spike|Drop, previous_value, reported_value, flagged_at }`
   stored on-chain, `performance_flagged` event published, distribution for the
   bond paused.
2. Review happens through the existing dispute mechanism:
   `oracle-consumer`'s `challenge_report` / `resolve_challenge` on the flagged
   report.
3. After resolution, `clear_performance_flag` (admin-only, nonce-protected)
   removes the flag and publishes `performance_unflagged`. A corrected report
   within bounds then distributes normally.

## Test coverage

`contracts/coupon-engine/src/lib.rs` (`mod test`):

- `test_first_performance_baseline_accepted` — baseline observation accepted.
- `test_performance_spike_flags_and_pauses_coupons` — +200% spike flagged,
  distribution paused, admin clears, corrected report distributes.
- `test_legitimate_extreme_drop_within_bounds` — a genuine −80% collapse is
  accepted.
- `test_erroneous_drop_flags_distribution` — a −97% drop is flagged.
- `test_insufficient_attestations_rejected` — a Verified report with a single
  verifier cannot drive payouts; a second attestation restores eligibility.
- `test_clear_performance_flag_requires_admin` — non-admin clearance rejected.
