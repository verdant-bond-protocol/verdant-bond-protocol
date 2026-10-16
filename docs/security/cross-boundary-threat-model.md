# Cross-Boundary Trust Threat Model (#347)

Scenario-based threat model for the points where Verdant Bond Protocol accepts
a claim from one trust domain and acts on it in another: green bond issuance,
KYC, carbon-credit oracle data, coupon payment, secondary-market settlement,
and the operators who support all of them.

Every threat row names the **executable checks** that guard it. The
traceability test `api/src/test/threat-model.spec.ts` parses this file and
fails CI if a referenced check is missing, or if a High-risk row has no check.
So when you add or move a guard, update the matching row here.

## Trust boundaries

| ID | Boundary | Untrusted side asserts… | Trusted side decides… |
|----|----------|-------------------------|-----------------------|
| B1 | Investor client → API | identity (JWT, wallet signature), intent, retries | whether to subscribe, claim coupons, place orders |
| B2 | KYC / sanctions providers → API | "this person is verified / not sanctioned" | eligibility tier committed on-chain |
| B3 | Oracle providers (Verra, satellite, IoT) → oracle service → `OracleConsumer` | "this project sequestered N tCO2e" | coupon step-up/step-down, credit issuance |
| B4 | API signer → Stellar / Soroban | (we assert) network, contract ids, sequence numbers | ledger state everyone else trusts |
| B5 | Buyer / seller → DEX router settlement | order, price cap, funds | atomic transfer of bond tokens and quote asset |
| B6 | Admin and support → privileged operations | "I am an operator acting on case X" | pauses, impersonation, evidence export |
| B7 | Workers and API → Redis state | idempotency records, job claims | whether a mutation or job runs again |
| B8 | Inbound webhooks → API | provider callbacks (KYC result, oracle events) | state transitions driven by the callback |
| B9 | Deployment config → runtime | env vars, contract ids, URLs, secrets | which network, contracts and keys every other boundary uses |

## Threat register

Risk = likelihood × impact for this protocol: **High** means loss of investor
funds, wrong coupon payouts, PII exposure, or acting on the wrong ledger.

| ID | Boundary | Abuse case | Risk | Mitigation | Checks |
|----|----------|------------|------|------------|--------|
| TM-01 | B1, B7 | A client retries a coupon claim or subscription (timeout, double-click, flaky mobile network) and the mutation runs twice | High | `Idempotency-Key` with an atomic reservation, an owner token for lost acks, one atomic retry claim after an error, and fail-closed when state is unreadable | `api/src/test/chaos.spec.ts`, `api/src/common/interceptors/idempotency.interceptor.spec.ts` |
| TM-02 | B8 | A forged or replayed KYC webhook marks an investor approved | High | HMAC signature, timestamp window, event-id replay cache | `api/src/webhooks/webhook-verification.service.spec.ts` |
| TM-03 | B2, B6 | KYC PII leaks on-chain (commitment payload) or to support staff (evidence exports) | High | Tier-only on-chain commitments with selective disclosure; evidence bundles redact secrets and PII and keep hashes and ids | `api/src/compliance/services/kyc-commitment.service.spec.ts`, `api/src/audit/evidence-bundle.spec.ts` |
| TM-04 | B2 | A sanctioned wallet passes because the sanctions list is stale | Medium | Staleness detection and alerts | `api/src/compliance/services/sanctions.service.spec.ts` |
| TM-05 | B3 | A compromised or careless oracle provider reports inflated sequestration to trigger a coupon step-down (issuer saves money) or step-up | High | Provider whitelist; cross-source anomaly detection; scoped circuit breaker with no auto-resume; challenge window | `api/src/oracle/anomaly.detector.spec.ts`, `api/src/oracle/circuit-breaker.service.spec.ts`, `api/src/oracle/oracle.challenge.service.spec.ts` |
| TM-06 | B9, B3 | The scheduler's default oracle provider is not in the whitelist, so reports are signed by an identity the contract will not trust (or a test provider stays whitelisted in production) | Medium | Config contract: whitelist entries are valid accounts and the default provider is a member | `api/src/common/config/config-contract.spec.ts` |
| TM-07 | B9, B4 | A mainnet deployment points at testnet RPC, a wrong or duplicated contract id, or staging secrets, so every trust decision is made against the wrong ledger | High | Config contract: target ↔ network ↔ endpoint agreement, distinct contract ids, no secrets or contract ids shared across environments | `api/src/common/config/config-contract.spec.ts`, `api/src/common/config/env-config.validator.spec.ts` |
| TM-08 | B9, B4 | The admin secret does not match the published admin address, or one key signs for several roles, so a single leak compromises issuer and investor flows | High | Config contract: admin key ↔ `STELLAR_PUBLIC_KEY`; distinct signer per role outside development; no file signer in production | `api/src/common/config/config-contract.spec.ts`, `api/src/common/services/signing-key.provider.spec.ts` |
| TM-09 | B4 | Concurrent submissions reuse a sequence number or nonce, so one is dropped or a replay is accepted | High | Contract-scoped atomic nonces that fail closed when Redis is down | `api/src/common/services/nonce.service.spec.ts` |
| TM-10 | B6 | A stolen admin session triggers a pause or parameter change | High | Short-lived signed admin intents bound to action and target, with nonces consumed on use | `api/src/common/services/intent.service.spec.ts` |
| TM-11 | B6 | Support impersonation is used beyond its case scope | Medium | Scoped, time-boxed impersonation | `api/src/impersonation/impersonation.service.spec.ts` |
| TM-12 | B5 | A settlement failure leaves an order filled without payment, or locked forever | High | Optimistic versioned order state; revert to Open on settlement failure | `api/src/marketplace/order-state.service.spec.ts` |
| TM-13 | B7 | A background coupon distribution or reconciliation job re-runs after it finished, or is lost when a worker crashes | High | Queue entry kept until terminal; processing lock is the claim and expires so crashed jobs are redelivered; late workers cannot overwrite terminal state | `api/src/test/chaos.spec.ts`, `api/src/workers/services/job-queue.service.spec.ts` |
| TM-14 | B6 | An evidence bundle is edited before it reaches a dispute or regulator | Medium | Bundle digest, chain linkage, and source verification pinned at export; the export itself is audited | `api/src/audit/evidence-bundle.spec.ts` |
| TM-15 | B5 | Secondary-market front-running and commit spam | Medium | See [order-matching-threat-model.md](order-matching-threat-model.md) | Contract-level, tracked in the linked model |

## Highest-risk scenarios in detail

### S1: Retry storm during coupon payment day (TM-01, TM-13)

**Scenario.** On a coupon date, thousands of investors claim at once. RPC
latency spikes, clients time out and retry, and a worker pod is evicted
mid-distribution.

**Trust decision.** Whether to execute a mutation again for a key the system
has already seen.

**What used to go wrong (fixed in #348):**

- **Concurrent retries after an error.** When an attempt failed, every
  concurrent retry read the same `error` record and executed.
- **Stale reads and Redis outages.** When Redis returned nothing, the
  interceptor executed the handler with no deduplication at all.
- **Lost acknowledgement on the reservation.** The pending record was written
  but the reply never arrived, wedging the key as "in progress" for 24h.
- **Failed read during completion.** The record was stored with an empty
  fingerprint, so every legitimate retry was rejected as "different payload".
- **Job removal was a no-op.** Removal used `sAdd`, so completed jobs were
  dequeued and run forever, and a dead letter was retried indefinitely.
- **Status write failed after a job finished.** The job was dropped from the
  queue while its status still read `processing`, so it was lost.

**Residual risk.** Delivery is at-least-once wherever a handler's external
effect lands but its result is not recorded (a crash after commit). Handlers
must deduplicate at the ledger, using the same signed transaction or nonce
(TM-09). Keys wedged in `pending` by a crash need the operator step in
[CHAOS_TEST_SUITE.md](../runbooks/CHAOS_TEST_SUITE.md#wedged-pending-idempotency-key).

### S2: Oracle-driven coupon manipulation (TM-05, TM-06)

**Scenario.** An issuer benefits from a coupon step-down if reported
sequestration crosses a threshold. A single compromised provider reports
inflated numbers just before the coupon observation date.

**Trust decision.** Whether one report is enough to move the coupon.

**Mitigation chain.** The provider must be whitelisted (and the config contract
proves the scheduler's default provider is). A single source is reported as
`missing_source`, not as truth. A deviating second source is flagged as an
outlier. A 3σ breach pauses only the affected project or tranche, and it never
auto-resumes. The challenge window lets any watcher dispute the report before
it finalises.

**Failure mode.** If all sources collude, detection fails. That is out of scope
for software and is mitigated by provider diversity (different operators,
methodologies and data paths).

### S3: Wrong-ledger deployment (TM-07, TM-08)

**Scenario.** A release promotes staging config to production, but
`SOROBAN_RPC_URL` still points at testnet, or `COUPON_ENGINE_ADDRESS` was
pasted from `BOND_ISSUER_ADDRESS`.

**Trust decision.** Every other boundary trusts the network and contract ids in
config.

**Mitigation.** `npm run config:contract -- --target=production --file=… --compare=<staging env>`
blocks the deploy (see [config-contract.md](../config-contract.md)). Per-field
validation still runs at boot (`EnvConfigValidator`).

### S4: Support investigation leaks KYC data (TM-03, TM-14)

**Scenario.** An investor disputes a rejected subscription. Support needs the
audit trail, but that trail contains emails, legal names, passport numbers and
wallet addresses.

**Trust decision.** How much a support engineer may see.

**Mitigation.** `GET /api/v1/audit/evidence/:type/:id?caseId=` (admin-only)
returns a redacted, digest-sealed bundle. See
[audit-evidence-bundles.md](../audit-evidence-bundles.md).

## Operational edge cases and recovery

| Situation | Behaviour | Recovery |
|-----------|-----------|----------|
| Redis down during an idempotent request | 409 "state unavailable" (fail closed), handler not run | Restore Redis; clients retry with the same key |
| Idempotency key stuck `pending` after a crash | 409 until resolved, never re-executed | Runbook: resolve from ledger truth |
| Worker crashes mid-job | Job redelivered after `PROCESSING_LOCK_SECONDS` (600s) | None; confirm the handler is ledger-idempotent |
| Config contract fails in CI | Deploy blocked | Fix env; never bypass for production |
| Evidence pepper rotated | Old bundles keep their `pepperId`; digests are not comparable across peppers | Keep retired peppers in the secret store for confirmation |
| Source audit chain fails verification | Bundle exports with `sourceVerification.ok=false`; offline verify fails | Escalate as an integrity incident ([INCIDENT_DRILL_RUNBOOK.md](../runbooks/INCIDENT_DRILL_RUNBOOK.md)) |

## Review cadence

Revisit this model when a new external integration, signer, contract or
privileged route is added, and on every incident post-mortem.
