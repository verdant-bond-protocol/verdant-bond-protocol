# Smart Contract Error Mappings

This document details how Soroban Rust smart contract error enums are mapped to stable API error codes in the Verdant Bond Protocol NestJS API.

---

## Architecture Overview

Soroban smart contracts return integer-based contract error codes (e.g. `Error(Contract, #1)`). Since each contract (such as `BondIssuer`, `OracleConsumer`, `DEXRouter`) defines its own enum starting at discriminant `1`, these error codes overlap.

To provide machine-readable error codes and descriptive messages to the frontend, the API dynamically maps numeric codes back to stable strings based on the target contract address.

```
+--------------------+
|  Soroban Contract  |
|  returns error #9  |
+---------+----------+
          |
          v
+---------+----------+
|   ContractService  |  <- Category resolved from ConfigService address (e.g. BOND)
|   performs lookup  |  <- Mapped to StableErrorCode.BOND_OVERFLOW
+---------+----------+
          |
          v
+---------+----------+
|  ContractException |  <- Thrown as HTTP 400 Bad Request
+---------+----------+
          |
          v
+---------+----------+
| Rfc7807Filter      |  <- Returns RFC 7807 JSON with code: "BOND_OVERFLOW"
+--------------------+
```

---

## Error Mappings Registry

The mappings are maintained in [`api/src/stellar/contract-errors.ts`](../api/src/stellar/contract-errors.ts).

### Error Categories
Contract addresses are grouped into these categories:
*   **`BOND`**: `BondIssuer` and `CouponEngine` contracts (uses `BondError` Rust enum).
*   **`ORACLE`**: `OracleConsumer` contract (uses `OracleError` Rust enum).
*   **`DEX`**: `DEXRouter` contract (uses `DEXError` Rust enum).
*   **`REGISTRY`**: `ProjectRegistry` contract (uses `RegistryError` Rust enum).
*   **`CREDIT`**: `CreditRetirement` contract (uses `CreditError` Rust enum).
*   **`GOVERNANCE`**: `Governance` contract (uses `GovernanceError` Rust enum).

---

## How to Update Mappings

When modifying error enums in the smart contracts, you **MUST** update the API mapping table to ensure frontend alignment and prevent CI failures.

### Step 1: Modify Rust Enum
If you add or shift variants in [`contracts/shared/src/errors.rs`](../contracts/shared/src/errors.rs), note the discriminant number.
```rust
pub enum BondError {
    NotInitialized = 1,
    ...
    NewErrorField = 13, // Added variant
}
```

### Step 2: Update TypeScript stable code and mappings
1.  Open [`api/src/stellar/contract-errors.ts`](../api/src/stellar/contract-errors.ts).
2.  Add the new string constant to the `StableErrorCode` enum:
    ```typescript
    export enum StableErrorCode {
      ...
      BOND_NEW_ERROR_FIELD = 'BOND_NEW_ERROR_FIELD',
    }
    ```
3.  Add the mapping under the appropriate category inside the `ERROR_MAPPINGS` dictionary:
    ```typescript
    export const ERROR_MAPPINGS = {
      BOND: {
        ...
        13: { code: StableErrorCode.BOND_NEW_ERROR_FIELD, message: 'Your detailed error description here' },
      }
    }
    ```

### Step 3: Run Verification Tests
Run the drift verification test to guarantee that TypeScript and Rust enums are in sync:
```bash
cd api
npx jest src/stellar/contract-errors.spec.ts
```
If there are any missing or mismatched discriminants, the test will print detailed diffs and fail.

---

## Consumer contract: classification and retry guidance (#641)

A stable code tells a consumer *what* failed. #641 also tells them *what to
do next*. Every `StableErrorCode` has an entry in
`CONTRACT_ERROR_CLASSIFICATION`, and the entry is typed as
`Record<StableErrorCode, …>`, so an unclassified code fails to compile.

### What the API returns

`ContractException` still renders as HTTP `400` with top-level
`code: "SETTLEMENT_FAILED"`, which existing clients may match on. The precise
classification is **added** under `contract`:

```json
{
  "status": 400,
  "code": "SETTLEMENT_FAILED",
  "retryable": false,
  "detail": "Bond redemption pool is underfunded",
  "remediation": "Retry only after the blocking condition in `contract.code` is resolved (…)",
  "contract": {
    "address": "C…", "method": "redeem", "rawErrorCode": 13,
    "code": "BOND_REDEMPTION_UNDERFUNDED",
    "category": "BOND",
    "errorClass": "insufficient_funds",
    "retryStrategy": "after_state_change"
  }
}
```

| `retryStrategy` | Meaning | `retryable` |
|---|---|---|
| `resync_nonce` | Stale replay nonce. Retry immediately; the API re-reads the on-chain nonce on every attempt. | `true` |
| `backoff` | Temporarily paused (migration, oracle pause, per-ledger volume cap), or the network rejected the submission with no contract code. | `true` |
| `after_state_change` | Retrying is pointless until something else changes, e.g. a report is verified, a pool is funded or a timelock elapses. | `false` |
| `none` | Authorization, validation, not-found or conflict. Never retry unchanged. | `false` |

`errorClass` is one of `authorization`, `not_found`, `conflict`,
`validation`, `state`, `insufficient_funds`, `stale_nonce`, `unavailable`,
`configuration`, `submission` or `unknown`.

### Edge cases

- **Overlapping discriminants:** `#4` from BondIssuer is `BOND_NOT_FOUND`, and
  from DEXRouter it is `DEX_ORDER_NOT_FOUND`. The category comes from the
  *contract address*, never from the number alone.
- **Unconfigured contract address or enum drift:** a raw code the API doesn't
  know becomes `UNKNOWN_CONTRACT_ERROR` with `errorClass: "unknown"`,
  non-retryable.
- **Submission rejected with no contract code** (e.g. `tx_bad_seq`):
  `UNKNOWN_CONTRACT_ERROR` *without* `rawErrorCode` is classed `submission`
  and stays retryable, which matches the legacy behaviour.
- **On-ledger failure after a successful simulation** (state changed in
  between): the contract code in the transaction diagnostics is now mapped. It
  used to become an unmapped `400`.
- **Detail text:** for non-retryable codes, `detail` is the curated message
  from `ERROR_MAPPINGS`, never the raw host diagnostic.
- **Service re-wrapping removed:** `BondsService.mapBondError` and
  `DexService.mapDexError` used to re-wrap unmapped `ContractException`s as
  plain `BadRequestException`s, which dropped the code. They now pass them
  through. `DexService` also applies its 409/404 mappings to
  `ContractException`s, which it previously skipped.
- **`GOVERNANCE` category:** mapped and tested, but `ContractService` has no
  configured governance address yet, so governance calls currently resolve to
  `UNKNOWN`. Add the address to `ConfigService` to activate it.

### Migration

The change is additive except for one deliberate fix: top-level `retryable`
now follows the precise classification. It was previously always `true` for
every contract error. A client that auto-retried on `retryable: true` will
stop retrying authorization, conflict and insufficient-funds failures. That
is the intended outcome, because those retries could never succeed.

### Drift that this change fixed

`contracts/shared/src/errors.rs` had grown variants the API never mapped:
`BondError` 20–36, `DEXError` 12–24 and 40, and `GovernanceError` 11–13. Those
failures reached consumers as `UNKNOWN_CONTRACT_ERROR`, and
`contract-errors.spec.ts` was failing on `main`. All of them are now mapped
and classified.

### Tests

```bash
cd api
npx jest src/stellar/contract-errors.spec.ts        # Rust ↔ TS discriminant parity
npx jest src/stellar/contract-error-mapping.spec.ts # RPC → exception → RFC 7807, per path
```
