# Oracle Design

## Architecture
Multi-source, multi-layer: Auditors + Satellite + IoT → OracleConsumer contract

## Provider Lifecycle
Register → Whitelisted → Submit Reports → Challenge Window → Verify/Reject

## Report Status Machine

```
Pending ──(threshold met)──► Verified
Pending ──(challenged)─────► Challenged
Verified ──(challenged)────► Challenged
Challenged ──(admin: Verified)──► Verified  (exonerated, no slash)
Challenged ──(admin: Rejected)──► Rejected  (provider slashed 10%)
```

Key invariants:
- Only `Pending` and `Verified` reports can be challenged.
- The challenge window is measured from `submitted_at` for `Pending` reports, and from `verified_at` for `Verified` reports.
- `CouponEngine.distribute_coupon` only accepts `Verified` reports. Reports in `Challenged` status block coupon distribution, holding coupons in escrow until the dispute is resolved.

## Report Format
```
{
  project_id: BytesN<32>,
  period_start: u64,
  period_end: u64,
  carbon_sequestered: i128,
  methodology: Symbol,
  provider_signature: BytesN<64>,
  ipfs_evidence_hash: BytesN<32>,
}
```

## Evidence Manifest Schema (#113)

Oracle adapters produce a canonical signed manifest tying raw observations, methodology, transformations, provider identity, and final submitted values together.

```json
{
  "project_id": "VCS-1234",
  "provider": "SatelliteProcessor",
  "signer_public_key": "VERDANT_ORACLE_KEY_V1",
  "methodology": "REMOTE_SENSING",
  "period_start": "2025-01-01",
  "period_end": "2025-12-31",
  "carbon_sequestered": 50000,
  "confidence": 0.85,
  "raw_observations": {
    "scene_ids": ["scene-101", "scene-102"],
    "sources": ["sentinel-2"],
    "scene_count": 2
  },
  "transformation_parameters": {
    "bbox": [-62.5, -3.5, -62.0, -3.0],
    "area_ha": 1000,
    "baseline_ndvi": 0.45,
    "max_cloud_cover": 20
  },
  "generated_at": "2025-12-31T23:59:59.000Z",
  "signature": "hmac_sha256_hex_digest_over_canonical_json"
}
```

### Verification Rules
1. **Schema Validation**: Validated via Zod (`EvidenceManifestSchema`).
2. **Signature Integrity**: HMAC-SHA256 signature generated over canonical (key-sorted) JSON of unsigned fields using provider key/secret. Tampered fields yield invalid signature verification.
3. **API Matching**: The NestJS API verifies that `project_id`, `methodology`, `period_start`, `period_end`, and `carbon_sequestered` in the manifest match the submitted DTO values exactly before transaction invocation.

## Evidence Hash Requirements

`ipfs_evidence_hash` (and the API's `SubmitReportDto.evidenceHash`) is a
reference to supporting evidence for a report -- satellite imagery, IoT
readings, field survey documents, or the report's own metadata. Because it
is stored on-chain as `BytesN<32>`, it must always resolve to exactly 32
bytes; two formats are supported:

- **CIDv0** -- an IPFS content identifier of the form `Qm` followed by 44
  base58btc characters, decoding to a 34-byte sha2-256 multihash
  (`0x12 0x20 <32-byte digest>`). The 2-byte multihash prefix is stripped
  before the digest is stored on-chain. This is the only format
  `hashEvidence()` (`ipfs/evidence.ts`) ever produces, and the only format
  every provider adapter (`oracle/verra-adapter.ts`,
  `oracle/satellite-processor.ts`, `oracle/iot-aggregator.ts`,
  `oracle/blue-carbon-adapter.ts`, via `oracle/report.ts`'s
  `buildOracleReport`) emits.
- **A raw 64-character hex string** -- a SHA-256 digest already encoded as
  hex, matching `sha256Hex()` (`ipfs/evidence.ts`) and the hex-encoded
  `ipfsHash`/`counterEvidenceHash` fields already used elsewhere in report
  and challenge responses.

**CIDv1 is not supported.** Nothing in this codebase's adapters, the IPFS
pinning path, or `oracle/validator.ts`'s on-chain pre-flight checks ever
produces one; a CIDv1-shaped reference is rejected the same as any other
unsupported format, not partially parsed.

### Validation

A malformed `evidenceHash` -- wrong length, invalid encoding, an unsupported
CID version -- is rejected by the API **before** the report's metadata is
uploaded to IPFS or `submit_report` is called on-chain. This happens at the
request-validation layer (`SubmitReportDto`'s `@IsEvidenceReference`
decorator), so a malformed reference never reaches `OracleService`. The
same two formats are validated independently on the provider-adapter side
via `isValidEvidenceHash()` (`ipfs/evidence.ts`), and on the API side via
`isValidCid()`/`encodeCid()` (`api/src/common/utils/cid.util.ts`) --
deliberately duplicated rather than shared, since the `api` and `oracle`
packages are built and deployed independently and do not share source at
runtime.

When `evidenceHash` is supplied on `POST /oracle/reports`, it -- not the
hash of the report metadata the API itself uploads to IPFS -- becomes the
on-chain `ipfs_evidence_hash`. The metadata upload still always happens (an
independent audit record of the submitted report body), but omitting
`evidenceHash` is what falls back to anchoring that metadata hash instead,
exactly as before this field carried its own validated meaning.

### Retrievability (optional)

Format validation is synchronous and never touches the network, so tests
for it run deterministically without depending on a public IPFS gateway.
Separately, and only when explicitly enabled, the API can also check that a
CIDv0 evidence reference actually resolves from the configured gateway
before anchoring it on-chain:

- `ORACLE_EVIDENCE_VERIFY_RETRIEVABILITY=true` enables the check (off by
  default).
- `ORACLE_EVIDENCE_RETRIEVABILITY_TIMEOUT_MS` bounds how long the check may
  take (default `5000`ms) -- a slow or unreachable gateway can never hang
  report submission.
- The check only applies to a CIDv0 reference; a raw hex digest names no
  gateway to fetch from, so it is skipped.
- An unretrievable evidence reference fails submission with a `422
  Unprocessable Entity` naming the evidence hash and the gateway response.

## Multi-Source Verification Threshold
A report only reaches `Verified` status after **independent verifications** meet the configured threshold:

- `set_signature_threshold(threshold)` sets the minimum number of distinct qualifying verifiers required (defaults to `2`).
- `set_minimum_verifier_stake(stake)` sets the minimum active stake a provider must hold before its verification can count (defaults to `10_000`).
- The admin may call `verify_report`; active providers may call it only when their stake is at or above the configured minimum. Each qualifying call records the verifier under `ReportVerifiers(report_id)` and increments `VerificationCount(report_id)`.
- Verifying the **same** report twice by the same address is a no-op (deduplicated, no double counting).
- A provider cannot verify its **own** report (`InvalidSignature`) — this guarantees the threshold represents genuinely independent sources.
- A report whose status is no longer `Pending` (challenged, already verified) cannot be re-verified.
- `get_report_verifiers(report_id)` and `get_verification_count(report_id)` expose the audit trail on-chain.

The admin can verify a report and it counts toward the threshold, but the submitting provider's own signature never does. Low-stake providers are rejected before their verification is recorded, so a self-registered provider cannot cheaply satisfy consensus for a colluding report.

## Challenge Mechanism
- 72-hour window from submission (for `Pending` reports) or from verification (for `Verified` reports)
- Any address can challenge with counter-evidence (IPFS hash) while the report is `Pending` or `Verified`
- Admin resolves via on-chain vote (`resolve_challenge`), settling the report to `Rejected` or `Verified`
- While a report is `Challenged`, `CouponEngine.distribute_coupon` rejects it, holding coupons in escrow

## Staking & Slashing
Providers stake collateral that is at risk if their reports are overturned:

- `add_stake(amount)` / `withdraw_stake(amount)` let an active provider top up or partially withdraw its own stake; withdrawals can never drop the stake below zero (`InsufficientStake`).
- On a challenge resolution to `Rejected`, the provider is slashed **10%** of its stake (`SLASH_PENALTY_PPM = 100_000`), transferred out of the provider's committed collateral.
- If the remaining stake reaches zero the provider is **deactivated** (`active = false`) and can no longer submit or verify reports.
- Resolving a challenge to `Verified` imposes **no** penalty — the challenger is wrong and the provider is exonerated.
- Every slash emits a `provider_slashed` event carrying the provider, penalty amount, remaining stake, and active flag.

## Provider Reliability Observability

The contract persists per-provider history so monitoring never has to replay
events or scan every report:

- `submit_report` increments a per-provider report counter.
- `challenge_report` records the challenged report id against the report's provider.
- `slash_provider` appends a `SlashRecord` (`report_id`, `penalty`,
  `remaining_stake`, `timestamp`, `active_after`) to the provider's history.

Query surface:

- `get_provider_stats(provider)` → `reports_submitted`, `challenges_faced`,
  `slashes`, `total_penalty`, `stake`, `active`.
- `get_slash_history(provider)` → `Vec<SlashRecord>`.
- `get_challenge_history(provider)` → `Vec<Challenge>` for that provider.

These power the API's `GET /oracle/stats/:providerAddress` endpoint and the
log-based staleness alerting described in
[`runbook-degraded-providers.md`](./runbook-degraded-providers.md).

## Cross-Source Anomaly Detection (#158)

Independent reports for the same project-period from different providers can be
compared so a single faulty, manipulated, or mis-entered measurement is not
accepted at face value. The monitor (and the API) compute a tolerance-based
cross-source assessment over the verified reports in each project-period:

- **Inputs.** Each `Verified` report contributes `(provider, methodology,
  carbonSequestered, periodStart, periodEnd)`. Reports are clustered by
  `projectId + (periodStart, periodEnd)` so each period is assessed separately.
- **Methodology families.** A methodology string is normalized to a family key
  (`VERRA-VCS`, `REMOTE-SENSING`, `IOT-SENSORS`, `BLUE-CARBON`, or `UNKNOWN`),
  and each family carries a relative tolerance (`METHODOLOGY_TOLERANCE`):
  VERRA-VCS 15%, REMOTE-SENSING 25%, IOT-SENSORS 35%, BLUE-CARBON 30%, default
  30%.
- **Algorithm.** For each cluster: with fewer than two sources the assessment is
  `missing_source` (no cross-check possible). Otherwise each source's deviation
  from the cluster median is compared against the family tolerance:
  - all within tolerance → `normal` (info),
  - exactly one source beyond tolerance → `outlier`,
  - two or more sources beyond tolerance → `conflicting_sources`.
  - A source deviating beyond **twice** the tolerance escalates the assessment
    to `critical` (otherwise `warning`).

Monitors and operators use these assessments to route investigation (e.g. a
remote-sensing outlier versus a registry estimate), and `critical` findings are
surfaced by the reliability scheduler.

Surfaces:

- Standalone oracle monitor: `POST /oracle/anomaly` (own service) and reusable
  `assessCrossSourceAnomaly` / `groupAndAssess` in `oracle/anomaly.ts`.
- API: `GET /oracle/monitoring/anomalies` → `OracleAnomalyReport` (computed by
  `OracleMonitoringService.computeCrossSourceAnomalies` over on-chain reports),
  and the 6-hourly `OracleScheduler` reliability cycle logs any `outlier` /
  `conflicting_sources` periods for review.


## Security Model
- Provider whitelist (admin-managed)
- Provider staking: committed collateral underwrites report quality; `add_stake` / `withdraw_stake` manage exposure
- Slashing: a `Rejected` challenge resolution slashes 10% of stake; zero stake deactivates the provider
- Signature threshold defaults to two independent qualifying sources, with minimum verifier stake required for provider votes
- Coupon distributions consume only `Verified` reports (enforced by `CouponEngine`); reports in `Challenged` status are rejected, holding coupons in escrow during disputes
- Multi-sig for high-value reports
# Report period conflicts

Report periods use half-open intervals (`[period_start, period_end)`). For a
given project, provider, and methodology, exact or partial overlaps are
rejected on-chain; adjacent periods are valid. Coupon eligibility also rejects legacy/indexed data
that contains overlapping periods.

## Multi-Oracle Aggregation & Outlier Rejection (#195)
- **Minimum Quorum:** Tunable via `set_minimum_quorum`. Requires `n >= min_quorum` verified reports per reporting window before aggregation computes a final performance metric.
- **Trimmed Mean Aggregation:**
  - `n < min_quorum`: returns `OracleError::InsufficientQuorum`.
  - `n == 2`: computes standard average `(r1 + r2) / 2`.
  - `n >= 3`: drops min and max reports, computing trimmed mean across intermediate observations.
- **Outlier Provider Slashing:** Providers submitting reports deviating by more than `MAX_ALLOWED_DEVIATION_BPS` (2,000 bps = 20%) from the consensus trimmed mean suffer a 10% stake slash and deactivation.

## Dispute & Arbitration Mechanism (#193)
- **Dispute Bond Requirement:** `challenge_report` requires challengers to stake at least `minimum_dispute_bond`.
- **Project-Level Coupon Freeze:** An active dispute sets `ProjectDisputed(project_id)`, freezing coupon math cross-contract (`BondError::ProjectDisputedAndFrozen`) across all dependent bonds.
- **Bad-Faith Disputer Slashing:** Upon arbitration (`resolve_challenge`), if the challenge is rejected (exonerating the report), 100% of the challenger's dispute bond is slashed. If upheld, the provider is slashed and the challenger receives their bond back.

## Oracle Staleness Thresholds & 3-Tiered Graceful Degradation (#192)
- **Configurable Thresholds:** `set_project_staleness_config` sets `threshold1_secs` (Tier 1 threshold), `threshold2_secs` (Tier 2 threshold), and `conservatism_discount_bps`.
- **Three-Tier Degradation:**
  - **Tier 0 (Fresh, `< threshold1`):** Full normal coupon credit calculations (`discount_bps = 0`).
  - **Tier 1 (Degraded / Discounted LKG, `threshold1 <= elapsed < threshold2`):** Applies `conservatism_discount_bps` reduction to total credits accrued during coupon distribution.
  - **Tier 2 (Critical / Stale, `>= threshold2`):** Blocks automated coupon math cross-contract (`BondError::OracleStaleManualInterventionRequired`), requiring manual administrative or governance review.

## CarbonChain Asynchronous True-Up Adjustments (#194)
- **Forward Application:** Audit updates or CarbonChain certification reconciliations are submitted via `submit_true_up_adjustment`.
- **No Retroactive Clawback:** Accumulated true-up adjustments are applied forward during the next scheduled coupon distribution window (`offset == 0`) without altering historical ledger distributions.
