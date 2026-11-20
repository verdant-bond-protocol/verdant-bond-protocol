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
