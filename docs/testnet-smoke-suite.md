# Testnet Smoke Suite

The Testnet Smoke Suite verifies the end-to-end operational lifecycle of the Verdant Bond Protocol on Stellar Testnet (or local Soroban test environment). It executes a full vertical slice through all four core protocol phases: **Issue**, **Subscribe**, **Coupon**, and **Redeem**.

For every stage, the suite verifies four distinct operational paths:
1. **Normal Path**: Happy-path protocol execution and state mutations.
2. **Failure Path**: Parameter bounds checking, constraint enforcement, and error responses.
3. **Retry Path**: Idempotent replays, safe re-queries, and post-state confirmation.
4. **Authorization Path**: RBAC boundaries, JWT authentication, and KYC enforcement.

Execution against **Mainnet is strictly prohibited** and blocked both in CLI arguments and runtime environment configuration.

---

## 1. Architectural Overview & Components

- **Core Suite (`api/src/ops/testnet-smoke-suite.ts`)**: Framework-independent testnet runner executing sequential lifecycle steps, measuring per-step latency, verifying assertions, and attributing failures to specific dependencies.
- **CLI Runner (`api/scripts/testnet-smoke-suite.ts`)**: Standalone executable CLI providing table and JSON reporting (`npm run smoke:testnet`).
- **Redemption API Integration (`api/src/bonds/bonds.controller.ts`, `api/src/bonds/bonds.service.ts`)**: Exposes `POST /api/bonds/:id/redeem` backed by `contracts/bond-issuer::redeem`, guarded by JWT authentication, KYC verification, and wallet ownership checks.
- **Automated Verification (`api/src/ops/testnet-smoke-suite.spec.ts`, `api/src/bonds/bonds.controller.guard.spec.ts`, `api/src/bonds/bonds.service.spec.ts`)**: Comprehensive unit and guard test coverage with zero external network dependencies during tests.

---

## 2. Four-Stage Lifecycle & Verification Matrix

```
       [ Stage 1: Issue ]
      Admin creates tranche
       ├── Auth: Non-admin rejected (401/403)
       ├── Fail: Negative face value / zero supply (400)
       ├── Normal: Tranche created (201)
       └── Retry: Idempotent bond query (200)
               │
               ▼
     [ Stage 2: Subscribe ]
      Investor funds bond
       ├── Auth: Unauthenticated / non-KYC rejected (401/403)
       ├── Fail: Amount exceeds total supply (400)
       ├── Normal: Subscription confirmed (200)
       └── Retry: Idempotency-Key resubmission (200)
               │
               ▼
      [ Stage 3: Coupon ]
      Admin distributes & investor claims
       ├── Auth: Non-admin coupon distribution rejected (401/403)
       ├── Fail: Negative period index rejected (400)
       ├── Normal: Admin distributes -> Investor claims credits (200)
       └── Retry: Re-claim returns 0 additional credits (200)
               │
               ▼
      [ Stage 4: Redeem ]
      Admin matures & investor redeems
       ├── Fail: Premature redemption before maturity rejected (400)
       ├── Auth: Non-admin maturity transition rejected (401/403)
       ├── Normal: Admin matures -> Investor redeems principal (200)
       ├── Fail: Redemption exceeding balance rejected (400)
       └── Retry: Holder balance query confirms burn to zero (200)
```

### Detailed Matrix by Stage & Path

| Stage | Path | Step Name | Request / Action | Expected Result | Blame Attribution |
|---|---|---|---|---|---|
| **Health** | Normal | `readiness-check` | `GET /api/health/ready` | HTTP 200 `status: ready` | `soroban-rpc` |
| **Issue** | Authorization | `issue-authorization-check` | `POST /api/bonds` (investor/unauth token) | HTTP 401 / 403 Forbidden | `auth` |
| **Issue** | Failure | `issue-validation-failure` | `POST /api/bonds` (negative face value, 0 supply) | HTTP 400 Bad Request | `validation` |
| **Issue** | Normal | `issue-bond-success` | `POST /api/bonds` (valid config, admin token) | HTTP 201 Created + `bondId` | `stellar-network` |
| **Issue** | Retry | `issue-query-retry` | `GET /api/bonds/:id` | HTTP 200 OK + active status | `api` |
| **Subscribe** | Authorization | `subscribe-authorization-check` | `POST /api/bonds/:id/subscribe` (no auth header) | HTTP 401 Unauthorized | `auth` |
| **Subscribe** | Failure | `subscribe-oversupply-failure` | `POST /api/bonds/:id/subscribe` (`amount > totalSupply`) | HTTP 400 Bad Request | `validation` |
| **Subscribe** | Normal | `subscribe-success` | `POST /api/bonds/:id/subscribe` (with `Idempotency-Key`) | HTTP 200 OK + `transactionHash` | `stellar-network` |
| **Subscribe** | Retry | `subscribe-idempotent-retry` | `POST /api/bonds/:id/subscribe` (replaying same key) | HTTP 200 OK (idempotent result) | `stellar-network` |
| **Coupon** | Authorization | `coupon-authorization-check` | `POST /api/bonds/:id/coupon` (non-admin token) | HTTP 401 / 403 Forbidden | `auth` |
| **Coupon** | Failure | `coupon-invalid-period-failure` | `POST /api/bonds/:id/coupon` (`periodIndex: -1`) | HTTP 400 Bad Request | `validation` |
| **Coupon** | Normal | `coupon-distribute-success` | `POST /api/bonds/:id/coupon` (`periodIndex: 0`) | HTTP 200 OK + `holderCount` | `stellar-network` |
| **Coupon** | Normal | `coupon-claim-credits-success` | `POST /api/bonds/:id/claim` (investor token) | HTTP 200 OK + credits claimed | `stellar-network` |
| **Coupon** | Retry | `coupon-reclaim-retry` | `POST /api/bonds/:id/claim` (re-claim) | HTTP 200 OK (0 additional credits) | `api` |
| **Redeem** | Failure | `redeem-premature-rejection-failure` | `POST /api/bonds/:id/redeem` (status = Active) | HTTP 400 Bad Request | `validation` |
| **Redeem** | Authorization | `mature-authorization-check` | `POST /api/bonds/:id/mature` (non-admin token) | HTTP 401 / 403 Forbidden | `auth` |
| **Redeem** | Normal | `mature-bond-admin-success` | `POST /api/bonds/:id/mature` (admin token) | HTTP 200 OK + status Matured | `stellar-network` |
| **Redeem** | Normal | `redeem-principal-success` | `POST /api/bonds/:id/redeem` (investor token) | HTTP 200 OK + `transactionHash` | `stellar-network` |
| **Redeem** | Failure | `redeem-insufficient-balance-failure` | `POST /api/bonds/:id/redeem` (`amount > balance`) | HTTP 400 Bad Request | `validation` |
| **Redeem** | Retry | `redeem-balance-burn-retry` | `GET /api/bonds/:id/holders` | HTTP 200 OK (balance is 0) | `api` |

---

## 3. Dependency Blame Model

When a smoke step fails, the suite identifies the root cause and attributes the error to one of the following dependencies:

| Blame | Trigger Condition | Recommended Operational Action |
|---|---|---|
| `soroban-rpc` | Readiness returns degraded RPC or unreachable contracts | Verify Soroban RPC URL, check node health, or re-fund RPC provider account. |
| `stellar-network` | Horizon/Soroban transaction submission failed or ledger timeout | Check Stellar Testnet status, verify account sequence numbers, check network fees. |
| `auth` | Authorization check was bypassed (e.g. 200 instead of 401/403) or valid token failed | Audit JWT signature secrets, check RBAC role mappings and KYC expiration. |
| `validation` | Invalid input or boundary condition was unexpectedly accepted | Investigate DTO validation pipes, class-validator decorators, and on-chain preconditions. |
| `api` | Node service unreachable, HTTP 500 error, or unexpected response format | Inspect NestJS service logs, review recent API deployments, check DB connectivity. |
| `config` | Invalid contract address or missing configuration keys | Review environment variables in `ConfigService` (`BOND_ISSUER_CONTRACT_ID`, etc.). |

---

## 4. Operational Edge Cases & Failure Modes

### 4.1 Stellar Ledger Close Latency & Timeouts
- **Edge Case**: Stellar ledgers close every ~5 seconds. Under testnet congestion or consensus stalls, transaction submission may take up to 20-30 seconds.
- **Handling**: Per-step request timeouts are configured with `stepTimeoutMs` (default 15s). The suite uses abort controllers to ensure hanging requests terminate cleanly and attribute latency to `stellar-network`.

### 4.2 Testnet Faucet Limits & Keypair Funding
- **Edge Case**: Testnet accounts require XLM balances for transaction fees and account reserves. If the testnet friendbot is throttled or accounts run low on XLM, Soroban invocations fail with `tx_bad_seq` or `insufficient_fee`.
- **Handling**: Account balances should be pre-funded using the testnet friendbot. If insufficient balance errors occur, `stellar-network` blame is raised.

### 4.3 Soroban RPC Sync Delay & Re-indexing Desync
- **Edge Case**: The on-chain contract state may update in ledger $N$, but local Redis caches or DB indexes might experience replication lag.
- **Handling**: Retries on queries (such as `issue-query-retry` and `redeem-balance-burn-retry`) allow for eventual consistency verification while verifying immediate state validity.

### 4.4 Idempotency Key Replay Collisions
- **Edge Case**: Replaying an API call with an existing `Idempotency-Key` while the initial transaction is still in-flight.
- **Handling**: The API's `IdempotencyInterceptor` locks in-flight requests and caches final responses. The smoke suite asserts that replaying with the same key returns HTTP 200 with identical results.

---

## 5. Recovery, Rollback, and Financial Invariants

### 5.1 Financial Invariants Preserved
1. **Supply Invariant**: $\sum \text{Investor Subscriptions} \le \text{Total Supply}$. Over-subscription is rejected at both API and smart contract levels.
2. **Redemption Conservation**: Redemption burns held bond tokens 1:1 on-chain. Post-redemption balance verification asserts that the investor's held token balance drops to zero.
3. **Maturity Precondition**: Bond principal can **never** be redeemed while the bond status is `Pending` or `Active`. The contract strictly requires `BondMaturityStatus::Matured` or `BondMaturityStatus::Defaulted`.
4. **Coupon Distribution Invariant**: Total distributed coupon credits equal the sum of verified project impact units. Investors cannot claim more than their pro-rata entitlement.

### 5.2 Rollback & Recovery Procedures
- **Failed Issue**: If bond creation fails mid-transaction, no state is registered in Redis, and no bond ID is stored. Retrying with fresh parameters creates a clean tranche.
- **Interrupted Subscription**: If an investor's transaction fails or times out, re-submitting with the same `Idempotency-Key` resolves without double-allocating bond tokens or charging duplicate funds.
- **Degraded Network Recovery**: If the smoke suite identifies `stellar-network` or `soroban-rpc` blame, traffic should temporarily fail over to a backup RPC provider or pause issuance until network consensus stabilizes.

---

## 6. Execution Guide

### Running via npm

```bash
# Run against local development environment
npm run smoke:testnet

# Run against remote testnet deployment
npm run smoke:testnet -- --base-url=https://api.testnet.verdantbond.org

# Output machine-readable JSON for monitoring and alerting pipelines
npm run smoke:testnet -- --json

# Run with custom credentials
SMOKE_ADMIN_TOKEN="<jwt>" \
SMOKE_INVESTOR_TOKEN="<jwt>" \
npm run smoke:testnet
```

### Environment Variables & Arguments

| Flag / Variable | Default | Description |
|---|---|---|
| `--base-url` / `TESTNET_API_URL` | `http://localhost:3000` | Target API base URL |
| `--network` / `STELLAR_NETWORK` | `testnet` | Target network (`testnet`, `local`, `mock`). `mainnet` is rejected. |
| `--json` | `false` | Emits raw JSON report to stdout |
| `SMOKE_ADMIN_TOKEN` | Mock admin JWT | JWT bearer token with maintainer/admin role |
| `SMOKE_ADMIN_ADDRESS` | Stellar test public key | Admin Stellar wallet address |
| `SMOKE_INVESTOR_TOKEN` | Mock investor JWT | JWT bearer token for KYC-verified investor |
| `SMOKE_INVESTOR_ADDRESS` | Stellar test public key | Investor Stellar wallet address |

### Exit Codes
- **`0`**: All stages and paths passed successfully.
- **`1`**: Smoke suite failure (one or more steps failed; inspect `blame` and `error`).
- **`2`**: Operational misuse (e.g. attempting to run on `mainnet`).
