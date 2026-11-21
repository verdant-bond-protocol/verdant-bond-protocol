# End-to-End Failure Injection Runbook: Payout and Redemption Flows (#474)

## 1. Overview
This runbook details the end-to-end failure injection framework and operational recovery procedures for the Verdant Bond Protocol's two most critical financial operations:
- **Payout Flows**: Periodic coupon distributions (`distribute_coupon`), investor credit claims (`claim_credits`), and administrative sweeps (`sweep_undistributed`).
- **Redemption Flows**: Bond maturity principal redemptions (`redeem`), pool settlement, and FIFO queue processing.

Failure injection allows engineers and automated CI/CD chaos suites to simulate catastrophic network, ledger, and liquidity anomalies deterministically while proving that financial invariants are never violated and stuck operations recover safely.

---

## 2. Injected Fault Modes & Behaviors

| Fault Mode | Trigger / Meaning | Target Flow | Invariant Safeguard |
|---|---|---|---|
| `TRANSIENT_RPC_TIMEOUT` | Soroban RPC gateway times out (504) after submitting transaction; status is in-doubt. | Payout, Redemption | Operation flagged in Partial Failure board. Status polled via `getTransactionStatus`. Retried safely with fresh nonce if uncommitted; deduplicated if committed. |
| `PRE_COMMIT_NETWORK_RESET` | Socket connection drops before the transaction reaches the node. | Payout, Redemption | Exponential backoff retry with identical idempotency key. Zero ledger mutation. |
| `UNDERFUNDED_REDEMPTION_POOL` | Liquid capital in redemption pool is insufficient to cover principal (`pool < amount * faceValue`). | Redemption | Immediate rejection with `RedemptionUnderfunded`. Critical alert dispatched. Zero holder tokens deducted; pool balance remains strictly non-negative. |
| `UNAUTHORIZED_CALLER` | Wallet fails role permissions or is flagged under active sanctions screening. | Payout, Redemption | Rejected with `403 Forbidden`. No state changes recorded. |
| `CONCURRENT_IDEMPOTENCY_REPLAY` | Identical request key received simultaneously from multiple nodes or re-submitted by client. | Payout, Redemption | Second request receives cached transaction response. Guaranteed zero duplicate credit minting or double debit. |
| `CORRUPTED_NONCE` | Account sequence number drift or out-of-order execution. | Payout, Redemption | Transaction rejected with `InvalidNonce`. Sequence re-synchronized and retried. |

---

## 3. Financial Invariants Enforced

Before and after every execution (whether successful, faulted, or recovered), the system evaluates:

1. **Credit Supply Conservation**:
   $$\text{totalCreditsIssued} = \text{claimedCredits} + \text{undistributedCredits}$$
   Credits can neither be created from nothing nor permanently lost during a failed payout.

2. **Token Supply Conservation**:
   $$\text{tokenSupply} = \sum_{h \in \text{holders}} \text{balance}(h)$$
   Tokens are only burned upon confirmed, verified redemption settlement.

3. **Pool Liquidity Conservation**:
   $$\Delta \text{redemptionPool} = -(\text{redeemedTokens} \times \text{faceValue})$$
   $$\text{redemptionPool} \ge 0$$
   Redemptions can never force the redemption pool into a deficit.

4. **Idempotent Single-Settlement**:
   Re-submitting any redemption or coupon distribution with the same idempotency key produces identical outputs and exactly zero secondary ledger state mutations.

---

## 4. Operational Paths

### Normal Path
1. Client initiates payout or redemption with `Idempotency-Key` header and signature.
2. Balance, nonce, and permissions are validated.
3. Soroban contract method is invoked on-chain.
4. Transaction confirms; balances update; invariants verified.
5. Emits `200 OK` or `201 Created`.

### Failure & Retry Path
1. Injected fault triggers (e.g. `TRANSIENT_RPC_TIMEOUT`).
2. Gateway timeout caught. The operation is registered on the **Partial Failure Dashboard**:
   - `operationType`: `payout.distribution` or `redemption.settlement`
   - `severity`: `warning` (for transient) or `critical` (for underfunded pool)
   - `retryable`: `true`
3. Background reconciliation worker queries transaction status from Soroban node by hash.
4. If unapplied: retries with refreshed sequence number up to `maxRetries`.
5. Once confirmed: dashboard record is marked `resolved` with resolution note and transaction hash.

### Authorization Path
1. Setting failure injection rules (`POST /api/v1/operations/failures/injection/rules`) requires administrative authority (`ROLE_MAINTAINER` / `MANAGE_INCIDENTS`).
2. Unauthenticated or non-admin requests are rejected with `401 Unauthorized` or `403 Forbidden`.

---

## 5. API Reference & Management

### Register an Injection Rule
```bash
curl -X POST https://api.verdantbond.org/api/v1/operations/failures/injection/rules \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "flowType": "PAYOUT",
    "failureMode": "TRANSIENT_RPC_TIMEOUT",
    "bondId": 1,
    "count": 1,
    "description": "Simulate gateway timeout on coupon distribution"
  }'
```

### Run Simulated Payout Flow
```bash
curl -X POST https://api.verdantbond.org/api/v1/operations/failures/injection/simulate/payout \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "bondId": 1,
    "amount": "50000",
    "recipientAddress": "GAINVESTOR1",
    "idempotencyKey": "sim_payout_test_01"
  }'
```

### Inspect Financial Invariants
```bash
curl -X GET https://api.verdantbond.org/api/v1/operations/failures/injection/invariants \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## 6. Recovery & Emergency Playbook

### Scenario A: Unresolved In-Doubt Payout
If an RPC timeout persists beyond automated retries:
1. Navigate to `/api/v1/operations/failures?operationType=payout.distribution&status=open`.
2. Inspect `metadata.externalRef` and `metadata.bondId`.
3. Check ledger directly:
   ```bash
   soroban contract invoke --id $COUPON_ENGINE_ADDR --source admin -- \
     claimable_credits --bond_id <BOND_ID> --holder <HOLDER_ADDR>
   ```
4. If credits were already distributed: mark record resolved on the dashboard.
5. If uncommitted: trigger manual retry from dashboard or re-submit via admin API with fresh nonce.

### Scenario B: Underfunded Redemption Pool Alert
If an `UNDERFUNDED_REDEMPTION_POOL` alert fires:
1. The protocol automatically halts further redemptions for this tranche.
2. Invariant verification confirms zero holder tokens debited.
3. Issuer must fund the redemption pool:
   ```bash
   soroban contract invoke --id $BOND_ISSUER_ADDR --source issuer -- \
     deposit_redemption_pool --bond_id <BOND_ID> --amount <REQUIRED_FUNDS>
   ```
4. Once funded, notify queued holders or re-run automated redemption sweep.

---

## 7. Injecting into the real flows (#644)

Sections 1–6 describe the simulator (`simulate/payout`, `simulate/redemption`),
which runs against in-memory mock balances. Since #644 the **same rules** also
drive the real `BondsService` payout and redemption paths. Faults go into
`ContractService.sendTransaction`, the single point every state-changing
contract call passes through. As a result, the real `NonceService`, stable
error mapping (#641) and RFC 7807 filter all handle a fault exactly as they
would in production.

### Enabling (staging / chaos runs only)

```bash
FAILURE_INJECTION_ENABLED=true   # and NODE_ENV must not be "production"
```

At boot, `ContractFaultInjectionBootstrap` attaches `ContractFaultInjector`.
It refuses to attach when `NODE_ENV=production` or when the flag is unset,
so production is unaffected. To roll back, unset the flag and restart; the
original transport is restored on module shutdown (`detach()`).

Rules are matched by contract method:
- **Payout:** `distribute_coupon`, `distribute_coupon_batch` and `claim_credits` map to `PAYOUT`.
- **Redemption:** `redeem` maps to `REDEMPTION`.

`bondId` and `targetAddress` are matched against the decoded call arguments.
`count` sets how many calls fault before the rule disarms.

### What each mode really does

| Mode | Sent to ledger? | Applied? | API outcome | Consumer action |
|---|---|---|---|---|
| `PRE_COMMIT_NETWORK_RESET` | no | no | `503` | Retry; it applies exactly once. |
| `TRANSIENT_RPC_TIMEOUT` | yes | **yes** | Redemption: reconciled `200 { reconciled: true }`. Payout: `504`. | See "In-doubt recovery" below. |
| `CORRUPTED_NONCE` | no | no | `BOND_INVALID_NONCE`, `retryable: true`, `resync_nonce` | Retry; the NonceService resyncs from chain. |
| `UNAUTHORIZED_CALLER` | no | no | `BOND_UNAUTHORIZED`, `retryable: false` | Fix the caller; never retry. |
| `UNDERFUNDED_REDEMPTION_POOL` | no | no | `BOND_REDEMPTION_UNDERFUNDED`, `after_state_change` | Fund the pool, then retry. |
| `CONCURRENT_IDEMPOTENCY_REPLAY` | yes | yes | passthrough | API-level mode; simulator only. |

### In-doubt recovery (corrects section 4)

A Soroban poll timeout means the transaction was **accepted and may have
applied**. Before #644, `ContractService` re-wrapped that timeout as a `400`,
and nothing deduplicated a retried redemption. What is guaranteed now:

- **`redeem`:** the contract has no duplicate guard, so a blind retry could
  redeem twice. `BondsService.redeem` reads the holder's contract nonce before
  the call and again after a timeout. Soroban reverts failed calls, so the
  nonce only moves when the redeem applied, and the NonceService lock
  serialises this API's calls per holder. This gives three outcomes:
  - **Nonce advanced:** the redeem applied. The API returns `200` with `reconciled: true`.
  - **Nonce unchanged:** nothing applied. The API returns `503`, which is safe to retry.
  - **Nonce unreadable:** the `504` is kept. Do **not** retry; reconcile holdings first.
- **`distribute_coupon`:** a retry is rejected on-chain because the period is
  already distributed (`BOND_OVERFLOW`, non-retryable). Credits are never paid twice.
- **`claim_credits`:** a retry drains an already-empty escrow and returns `0` credits.

Every injected timeout also records a `retryable: false` entry on the Partial
Failure board (`payout.distribution` or `redemption.settlement`, keyed by the
transaction hash), so the incident stays visible.

### Executable verification

`api/src/failures/payout-redemption.e2e-failure-injection.spec.ts` runs the
real `BondsService`, `ContractService`, `NonceService` and RFC 7807 filter
against an in-memory ledger. The ledger enforces the contract guards: nonces,
admin authorization, pool solvency and one distribution per period. After
every scenario the spec asserts that four quantities are conserved: token
supply, principal (pool plus paid principal), credits, and a non-negative pool.

```bash
cd api && npx jest src/failures/payout-redemption.e2e-failure-injection.spec.ts
```
