# Architecture

## Smart Contracts

### BondIssuer

```rust
// Public functions
pub fn issue_bond(...)                         // validates project is Approved via ProjectRegistry
pub fn set_project_registry(caller, registry)  // admin: link ProjectRegistry for cross-contract validation
pub fn subscribe(...)
pub fn transfer(from, to, bond_id, amount, nonce)   // replay-protected on-chain token transfer
pub fn fund_redemption(caller, bond_id, amount, nonce)  // admin funds principal escrow
pub fn redeem(...)
pub fn mature_bond(...)
pub fn preview_subscribe(bond_id, amount)          // read-only dry run: remaining supply + the error subscribe would return
pub fn set_admin(current_admin, new_admin, nonce)
pub fn get_admin()
pub fn get_bond(...)
pub fn get_bond_state(...)
pub fn get_holder_balance(...)
pub fn get_redemption_pool(...)
pub fn get_nonce(holder)
pub fn bond_count(...)
```

### CouponEngine

```rust
// Public functions
pub fn distribute_coupon(caller, bond_id, period, holders, report_id, nonce)
pub fn claim_credits(caller, bond_id, nonce)   // withdraw accrued credits
pub fn consume_credits(holder, bond_id, amount)  // holder-authorized debit; called by CreditRetirement before it mints a certificate
pub fn sweep_undistributed(caller, bond_id, nonce)  // admin-only dust recovery
pub fn accrued_credits(...)
pub fn accrued_credits_by_type(bond_id, holder, credit_type)  // per-type split for Basket bonds
pub fn get_bond_credit_type(bond_id)
pub fn get_period_info(...)
pub fn get_period_count(...)
pub fn get_undistributed_total(...)
```

### OracleConsumer

```rust
// Public functions
pub fn register_provider(...)
pub fn add_stake(...)              // commit provider collateral
pub fn withdraw_stake(...)         // partial withdrawal of own stake
pub fn submit_report(...)
pub fn verify_report(...)            // independent verifier endorsement
pub fn challenge_report(...)
pub fn resolve_challenge(...)        // admin verdict; Rejected slashes 10% stake
pub fn slash_provider(caller, provider, report_id, nonce)  // admin: apply the slash directly
pub fn preview_slash(provider, report_id)             // read-only: penalty and remaining stake
pub fn set_signature_threshold(...)  // required independent verifications
pub fn set_admin(current_admin, new_admin, nonce)
pub fn get_admin()
pub fn get_report(...)
pub fn get_provider(...)
pub fn get_verification_count(...)
pub fn get_report_verifiers(...)
```

### DEXRouter

```rust
// Public functions
pub fn deposit_quote(...)      // escrow quote asset for purchases
pub fn withdraw_quote(...)     // pull escrowed proceeds back
pub fn get_quote_balance(...)
pub fn list_bond_tokens(...)   // escrow bond tokens at listing time
pub fn execute_purchase(...)   // verify escrow, atomically transfer bonds + quote
pub fn cancel_listing(...)     // release escrowed bond tokens
pub fn get_seller_bond_escrow(...)  // query escrowed bond balance
pub fn set_admin(current_admin, new_admin, nonce)
pub fn get_admin()
pub fn clean_expired_orders(caller, start_id, limit, nonce)  // batched expired cleanup
pub fn get_order(...)
pub fn get_orders_by_seller(...)
```

### ProjectRegistry

```rust
// Public functions
pub fn register_project(...)
pub fn approve_project(...)                    // Pending -> Approved (admin)
pub fn reject_project(...)                     // Pending -> Rejected (admin)
pub fn deactivate_project(caller, project_id)  // Approved -> Inactive (admin, for fraud/withdrawal)
pub fn resubmit_project(caller, project_id, updated_ipfs_hash) // Rejected -> Pending (owner, preserves id/history)
pub fn get_project(...)
pub fn get_all_projects(...)
pub fn has_approved_project(key)               // view: true iff status == Approved
pub fn project_key(project_id)                 // helper: u64 -> BytesN<32> storage key
pub fn add_project_documents(caller, project_id, hashes, nonce)  // owner or admin only
```

### CreditRetirement

```rust
// Public functions
pub fn retire_credits(...)
pub fn get_retirement_record(...)
pub fn get_retired_balance(...)
```

## Storage Layout

| Contract        | DataKey                        | Value Type     | Description                                                     |
| --------------- | ------------------------------ | -------------- | --------------------------------------------------------------- |
| BondIssuer      | Bond(bond_id)                  | BondConfig     | Bond configuration                                              |
| BondIssuer      | HolderBalance(bond_id, holder) | i128           | Token balance                                                   |
| BondIssuer      | BondState(bond_id)             | BondState      | Current bond state                                              |
| BondIssuer      | RedemptionPool(bond_id)        | i128           | Escrowed face-value principal available for matured redemptions |
| BondIssuer      | ProjectRegistry                | Address        | Optional cross-contract link enforcing Approved-only issuance   |
| CouponEngine    | Coupon(bond_id, period)        | CouponData     | Coupon distribution                                             |
| CouponEngine    | Accrued(bond_id, holder)       | i128           | Accrued credits                                                 |
| CouponEngine    | UndistributedTotal(bond_id)    | i128           | Unallocated coupon dust                                         |
| OracleConsumer  | Report(report_id)              | OracleReport   | Measurement report                                              |
| OracleConsumer  | Provider(addr)                 | OracleProvider | Oracle provider (stake, active)                                 |
| DEXRouter       | Order(order_id)                | OrderData      | Marketplace order                                               |
| DEXRouter       | Balance(symbol, addr)          | i128           | Escrowed quote-asset balance                                    |
| DEXRouter       | BondEscrow(bond_id, addr)      | i128           | Escrowed bond token balance (locked at listing time)            |
| ProjectRegistry | Project(project_id)            | ProjectInfo    | Project record                                                  |

### Storage Key Schema Fixtures & Migration Compatibility (#159)

Every `DataKey` variant across all seven contracts is snapshot in
[`contracts/tests/fixtures/storage_keys.json`](../contracts/tests/fixtures/storage_keys.json)
as hex-encoded XDR of the serialized key value, tagged with the canonical Rust
constructor expression (e.g. `PeriodHolder(1, 1, addr, BlueCarbon)`).

- **Canonical representation.** The hex is the on-the-wire `ScVal` XDR the
  contract passes to `env.storage().instance().get/set` (the physical ledger
  slot additionally hashes this value; the XDR is the human-auditable anchor).
- **Drift guard.** `nbbs-tests::storage_schema::storage_fixture_file_matches_current_schema`
  fails CI whenever the generated hex diverges from the committed file — so
  adding/removing/reordering a `DataKey` variant, or changing a payload type,
  breaks the build until the fixture is intentionally regenerated.
- **Regeneration.** After an intentional schema change, regenerate with:

  ```text
  cargo test -p nbbs-tests --features storage-fixture-update regenerate_storage_fixture_file
  ```

  The generator lives in the `nbbs-storage` crate (`generate_storage_fixtures`),
  which serializes the live `DataKey` enums so the snapshot never drifts from
  `main`.

This gives migration reviewers a precise before/after of the storage key space
when a release changes contract state, and provides a machine-readable manifest
for migration tooling.

## Cross-Contract Calls

```
BondIssuer ──► ProjectRegistry (verify project is Approved; rejects Inactive/unregistered via has_approved_project)
ProjectRegistry ──► BondIssuer (legacy verify path)
BondIssuer ──► CouponEngine (distribute coupons)
CouponEngine ──► OracleConsumer (read verified reports by report_id)
DEXRouter ──► BondIssuer (settle purchase via transfer, debiting seller / crediting buyer)
CreditRetirement ──► CouponEngine (verify credit ownership)
```

## Project Lifecycle

```
Pending ──approve_project(admin)──► Approved ──deactivate_project(admin)──► Inactive (terminal)
  │                                     │
  └──reject_project(admin)──► Rejected ─┘
                                │
                                └──resubmit_project(owner, updated_ipfs_hash)──► Pending (same project_id, history preserved)
```

- `register_project` creates a `Pending` project. Only an admin may `approve_project` (→ `Approved`) or `reject_project` (→ `Rejected`) from `Pending`.
- `deactivate_project` transitions an `Approved` project to `Inactive` (admin-only). This is the retirement path for fraudulent or withdrawn projects; `Inactive` is terminal.
- `resubmit_project` allows the original owner to return a `Rejected` project to `Pending` with updated IPFS documentation, preserving `project_id` and on-chain history (vs. registering a new id).
- `BondIssuer.issue_bond` cross-calls `ProjectRegistry.has_approved_project(project_id)` when a registry is linked via `set_project_registry`. Only `Approved` projects may back new bonds; `Inactive`, `Rejected`, `Pending`, and unregistered projects are rejected with `BondError::ProjectNotApproved`.

## Oracle Report Status Machine

Reports follow a strict status lifecycle managed by `OracleConsumer`:

```
                   ┌──────────┐
                   │ Pending  │
                   └────┬─────┘
                        │
          ┌─────────────┼─────────────┐
          ▼                           ▼
   ┌──────────┐                ┌────────────┐
   │ Verified │◄───────────────│ Challenged │
   └──────────┘  (exonerated)  └─────┬──────┘
          ▲                           │
          │                 (overturned)
          │                           ▼
          │                    ┌──────────┐
          └────────────────────│ Rejected │
                               └──────────┘
```

- **Pending → Verified**: report accumulates independent verifier signatures up to the configured `SignatureThreshold`.
- **Pending → Challenged**: any address submits counter-evidence within the challenge window.
- **Verified → Challenged**: any address disputes a verified report within the challenge window (measured from `verified_at`).
- **Challenged → Verified**: admin resolves the challenge in favour of the provider (report exonerated, no slash).
- **Challenged → Rejected**: admin overturns the report; the provider is slashed 10% of stake.
- **CouponEngine coupling**: `distribute_coupon` only accepts reports in `Verified` status. While a report is `Challenged`, coupons for the associated bond period are held in escrow until the dispute is resolved.

## Bond Maturity

- A bond matures when the ledger timestamp reaches its `maturity_date` — `mature_bond` rejects calls made before that instant (`BondError::Overflow`).
- Once the maturity date elapses, `subscribe` and `transfer` are rejected even if the bond has not yet been admin-matured, so the bond's outstanding supply is frozen on schedule.
- `redeem` still requires the explicit `Matured` state, keeping redemption a deliberate admin-acknowledged step.
- Before holders can redeem, the admin must call `fund_redemption` with enough escrowed principal to cover `amount * face_value`. `redeem` decrements the holder balance, total subscribed amount, and redemption pool atomically; if the pool is underfunded, the holder balance is left unchanged.
- `BondConfig.total_supply` is capped by `MAX_SUPPLY` to keep downstream fixed-point coupon math inside safe `i128` bounds.

## Admin Rotation

- Every admin-bearing contract exposes `set_admin(current_admin, new_admin, nonce)` and `get_admin()`.
- `set_admin` requires authorization from the current admin address, consumes that admin's nonce, and emits `admin_changed`. The trailing nonce is what lets `Governance.execute` drive it; see docs/access-control-review.md.
- Production rotations should be scheduled through the Governance contract's timelock and executed by the current HSM-held admin key after review.

## Marketplace Settlement

- Buyers must first `deposit_quote` a quote asset (e.g. USDC) into the DEXRouter; purchases otherwise fail with `DEXError::InsufficientFunds`.
- Sellers must first `list_bond_tokens` to enter their orders; at listing time, the requested bond tokens are **escrowed** in the DEXRouter (cannot be transferred away via BondIssuer).
- `get_seller_bond_escrow(seller, bond_id)` surfaces the escrowed balance for order validation and API filtering.
- `execute_purchase` verifies the seller's escrowed balance **before** attempting the cross-contract transfer (`BondIssuer.transfer`); if the seller has transferred tokens away (bypassing the DEX), the purchase fails gracefully with `InsufficientBalance` instead of silently failing partway through.
- `execute_purchase` atomically transfers bond tokens (`BondIssuer.transfer`) and escrowed quote (`price_per_token * amount`) from buyer to seller, releasing the seller's escrow for the filled amount. A fill either fully settles or fully reverts.
- Sellers can `withdraw_quote` their proceeds; `get_quote_balance` reports escrowed balances by symbol.
- Expired-order cleanup is **cursor-batched**: `clean_expired_orders(caller, start_id, limit, nonce)` scans at most `min(limit, 100)` order IDs per call and returns `(cleaned, next_start_id)` so an off-chain scheduler can finish the book across multiple invocations without a full-table scan.
- **Tradeoff:** lazy/opportunistic cleanup was considered and rejected: marking an order `Expired` inside `execute_purchase`'s error path cannot work (a Soroban call that returns an error reverts all writes), and scanning a seller's full order list inside `list_bond_tokens` would reintroduce unbounded cost on a user path. The periodic cursor-batched admin sweep is the cleanup mechanism.
- `cancel_listing` releases the escrowed bond tokens back to the seller's control.
- **Escrow Design**: Both buyers and sellers have escrow protections:

## Marketplace Reconciliation

The API keeps an indexed/cached view of marketplace state (quote-balance cache in
`DexService` plus the order caches used by `listOrders`/`getOrder`). To catch
divergence, cache-invalidation gaps, or unexpected on-chain movement, a scheduled
reconciliation job (`DexReconciliationService`, cron `DEX_RECON_CRON`, default
every 10 minutes) compares this view against the DEXRouter ledger:

- **Quote balances** — `quote:balance:<addr>:<asset>` vs `get_quote_balance`.
- **Open orders** — the API order index vs `get_order` status; plus an escrow
  invariant (`pricePerToken * amount <= seller on-chain balance`).
- **Missing orders** — on-chain open orders absent from the API index.

Mismatches are logged with a `correlationId` and persisted to
`dex:recon:last` / `dex:recon:mismatches`. The repair path (`repair()` and
`POST /marketplace/reconciliation/repair`) evicts the affected caches so the next
read re-fetches from the ledger. See
`docs/runbook-marketplace-reconciliation.md` for the operator investigation and
repair steps.
  - **Buyers**: Quote asset escrowed at `deposit_quote`; balance checked before transfer.
  - **Sellers**: Bond tokens escrowed at `list_bond_tokens`; balance checked before transfer. Prevents order fulfillment failure due to seller side-transfers.

## Coupon Integrity

- `CouponEngine.distribute_coupon` accepts an **on-chain `report_id`** instead of a caller-supplied report, eliminating fabricated distributions.
- It reads the report from the `OracleConsumer` contract and rejects any report whose status is not `Verified` (`ReportNotVerified`). Reports in `Challenged` status are rejected, effectively holding coupons in escrow while a dispute is active.
- The report's `project_id` must match the bond's registered project, otherwise distribution is rejected.
- The verified report id is persisted in `PeriodInfo`, making every distribution auditable back to its evidence.
- Integer-division remainder that cannot be allocated to holders is recorded as `undistributed` per period and aggregated in `UndistributedTotal`; the admin can recover it via `sweep_undistributed`, preventing value from being silently lost.

## API Layer

### KYC State Model (Durable Compliance Store)

KYC state used to live **only** in Redis under `kyc:<address>` — volatile, unauditable,
and indistinguishable from cache. It is now a three-layer model:

| Layer | Store | Role | Notes |
| ----- | ----- | ---- | ----- |
| 1 (Source of Truth) | `KycStoreService` — durable JSON snapshot + append-only JSONL audit log in `data/kyc/` (configurable via `KYC_STORE_DIR`) | Every status change is a persisted `KycAuditEntry` with from/to status, actor, reason, providerReference, and expiresAt. | Snapshot is atomic (`rename` from `.tmp.<pid>`); audit is `fs.appendFile` so a snapshot loss can be replayed. |
| 2 (Write-through cache) | Redis `kyc:<address>` → JSON-encoded `KycRecord` with 60s TTL | Eliminates durable reads on every guard check. | Invalidated + re-written on every transition. Malformed cache rows fall back to durable store. |
| 3 (Access / Guard) | `KycGuard` + `AuthService.getProfile` | Always goes through `KycService`, never talks to Redis directly. | |

**KycRecord shape (durable + cache):**
```ts
{
  address,
  status: NONE | PENDING | VERIFIED | ACCREDITED | EXPIRED | REJECTED,
  source: 'provider' | 'admin' | 'system' | 'import',
  actor,               // admin/provider identity that performed the change
  reason,              // human-readable justification
  providerReference,   // opaque ID from the external KYC vendor (audit linkage)
  createdAt, updatedAt, expiresAt
}
```

**KycAuditEntry shape (append-only log):**
```ts
{ id, address, fromStatus, toStatus, source, actor, reason, providerReference, expiresAt, timestamp }
```

**Status lifecycle / downgrade semantics:**

```
   NONE → PENDING ──► VERIFIED ──► ACCREDITED
                     │    │            │
                     │    │            │  expiresAt <= now
                     │    ▼            ▼
                     │  EXPIRED ◄──────┘   (automatic on lookup + logged as system transition)
                     │
                     ▼
                  REJECTED   (admin with mandatory reason)
```

- An expired `VERIFIED` / `ACCREDITED` record becomes effective `EXPIRED` on read.
  The next full-read (`getFullStatus`) writes a durable `EXPIRED` transition for audit
  so the downgrade is visible without inferring it from timestamp math.
- `REJECTED` is a terminal state that requires a mandatory `reason`.
- The KYC guard throws differentiated 403 messages: `KYC verification has expired`,
  `KYC verification was rejected`, or the generic `KYC verification required`.

**Admin API endpoints** (all behind `JwtAuthGuard`; real deployments should gate with an admin role):

| Method | Endpoint             | Description |
| ------ | -------------------- | ----------- |
| GET    | /auth/profile        | Own profile enriched with KYC record + last 50 audit entries |
| GET    | /auth/kyc/:address   | Read another user's KYC record + 100-entry audit tail |
| POST   | /auth/kyc/:address   | Admin status transition: `{ status, source?, actor?, reason?, providerReference?, expiresAt? }` → returns `{ record, entry, isNew }` |

**Operational notes:**
- Set `KYC_STORE_DIR` to a persistent volume mount in production. An ephemeral container
  filesystem is still better than Redis-only (you can backup the JSONL log), but the
  intended production setup is bind-mounted storage or a switch of `KycStoreService` to
  the same Postgres used for `DATABASE_URL`.
- Redis is **cache only**. `FLUSHALL` does not lose compliance state. You can rebuild
  every `kyc:<address>` cache entry by iterating `KycStoreService.list()` and writing
  through.
- Audit log is the compliance trail. Never truncate `kyc-audit.log.jsonl`. It is replayed
  on startup after loading `kyc-records.json`, so the snapshot is only a performance
  optimisation — the log is ground truth.

### Method Table

| Method | Endpoint                       | Description                                         |
| ------ | ------------------------------ | --------------------------------------------------- |
| POST   | /bonds                         | Issue a new bond tranche                            |
| GET    | /bonds                         | List active bond tranches                           |
| GET    | /bonds/:id                     | Get bond details                                    |
| POST   | /bonds/:id/subscribe           | Subscribe to bond                                   |
| GET    | /bonds/:id/holders             | List token holders                                  |
| POST   | /bonds/:id/coupon              | Trigger coupon distribution (by report_id)          |
| POST   | /bonds/:id/claim               | Claim accrued credits                               |
| GET    | /bonds/:id/undistributed       | Get undistributed coupon dust total                 |
| POST   | /bonds/:id/sweep-undistributed | Admin: sweep undistributed coupon dust (admin only) |
| POST   | /bonds/:id/transfer            | Transfer bond tokens to another address             |
| POST   | /projects                      | Register project                                    |
| GET    | /projects                      | List projects                                       |
| GET    | /projects/:id                  | Get project details                                 |
| POST   | /projects/:id/documents        | Upload IPFS docs                                    |
| GET    | /marketplace/orders            | List open orders                                    |
| POST   | /marketplace/list              | List tokens for sale                                |
| POST   | /marketplace/buy               | Purchase tokens                                     |
| GET    | /marketplace/prices            | Current prices                                      |
| POST   | /oracle/reports                | Submit oracle report                                |
| GET    | /oracle/reports/:projectId     | Get project oracle history                          |
| POST   | /oracle/challenge/:reportId    | Challenge a report                                  |
| GET    | /oracle/reports/:projectId/challenges | List challenged reports for a project (with challenge detail) |
| GET    | /oracle/challenges/:reportId   | Challenge state + resolution history for a report  |
| GET    | /oracle/projects/:projectId/coupon-eligibility | Coupon-distribution eligibility for a project |
| GET    | /oracle/stats/:providerAddress | Provider stats + slash/challenge history            |
| GET    | /oracle/monitoring/staleness   | Per-project/provider staleness metric               |
| POST   | /marketplace/reconciliation/run | Operator: run quote-balance/order reconciliation   |
| GET    | /marketplace/reconciliation/mismatches | Operator: list last reconciliation mismatches |
| POST   | /marketplace/reconciliation/repair | Operator: repair stale cache/index records      |

## Frontend

### Component Tree

```
AppComponent
├── WalletButtonComponent
├── DashboardComponent
│   ├── BondCardComponent
│   └── ProjectCardComponent
├── ProjectsListComponent
│   └── ProjectCardComponent
├── ProjectDetailComponent
│   └── StatusBadgeComponent
├── ProjectCreateComponent
├── BondsListComponent
│   ├── BondCardComponent
│   └── StatusBadgeComponent
├── BondDetailComponent
│   ├── StatusBadgeComponent
│   └── LoadingSpinnerComponent
├── IssueBondComponent
├── MarketplaceListComponent
│   ├── StatusBadgeComponent
│   └── LoadingSpinnerComponent
├── MarketplaceSellComponent
└── AuthComponent
```

### Route Map

```
/ → redirect to /dashboard
/dashboard → DashboardComponent
/projects → ProjectsListComponent
/projects/new → ProjectCreateComponent
/projects/:id → ProjectDetailComponent
/bonds → BondsListComponent
/bonds/issue → IssueBondComponent
/bonds/:id → BondDetailComponent
/marketplace → MarketplaceListComponent
/marketplace/sell → MarketplaceSellComponent
/auth → AuthComponent
```
# Project provenance

`GET /projects/:id/provenance` assembles registration, review, oracle report,
bond issuance, and document evidence into one chronological response. Entries
without a ledger timestamp are retained with a null timestamp and explicit
pending/complete state instead of inventing ordering data.
