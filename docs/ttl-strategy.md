# Soroban Storage TTL and Archival Restore Strategy

Nature-based bonds can live for years. This document defines how persistent
storage entries are managed to prevent archival or expiry under Stellar's
state archival rules.

## Background

Soroban charges rent for persistent and instance storage entries. Entries that
are not extended may eventually be archived by the network, making them
unreadable and unmutable until restored. Bonds with multi-year maturities,
ongoing coupon distributions, and long-lived oracle stakes require explicit
TTL management.

## Storage Key Categories

### Tier 1 — Must survive bond lifetime (years)

These entries must never be archived while a bond is active or a project is
registered:

| Contract | Key | Lifetime | Notes |
|---|---|---|---|
| BondIssuer | `Bond(id)` | Bond maturity + grace period | Core bond state; holders depend on it |
| BondIssuer | `Holder(bond_id, addr)` | Bond maturity + grace period | Holder balances and claim state |
| BondIssuer | `Config` | Permanent | Bond configuration (face value, schedule, etc.) |
| CouponEngine | `BondSchedule(bond_id)` | Bond maturity + grace period | Coupon distribution schedule and claims |
| ProjectRegistry | `Project(id)` | Permanent | Project metadata and approval status |
| ProjectRegistry | `ProjectCount` | Permanent | Auto-incrementing ID counter |
| Governance | `Proposal(id)` | 7 days after execution or rejection | Timelock proposals |
| Governance | `Config` | Permanent | Multi-sig signers and threshold |

### Tier 2 — Medium-lived (weeks to months)

| Contract | Key | Lifetime | Notes |
|---|---|---|---|
| OracleConsumer | `Provider(addr)` | Active while provider is registered | Provider stake and status |
| OracleConsumer | `Report(id)` | 90 days after resolution | Audit trail for verified/challenged reports |
| DEXRouter | `Order(id)` | Until filled, cancelled, or expired | Active marketplace orders |
| DEXRouter | `Escrow(addr, asset)` | Until withdrawn | Deposited quote tokens |

### Tier 3 — Short-lived (days)

| Contract | Key | Lifetime | Notes |
|---|---|---|---|
| CouponEngine | `CouponPeriod(bond_id, idx)` | 30 days after distribution | Historical coupon period data |
| CreditRetirement | `Retirement(id)` | Permanent | Burn certificates for audit trail |

## Extension Strategy

### Automatic extension on mutation

Any write to a Tier 1 entry should also call `extend_contract_data` (or
equivalent) to push the TTL forward. This is a low-cost operation bundled
into the existing transaction:

```rust
// Extend a bond entry to survive at least 5 years from now.
let five_years = 5 * 365 * 24 * 60 * 60; // seconds
env.storage().persistent().extend(
    &DataKey::Bond(bond_id),
    five_years,
);
```

### Periodic keeper job

A scheduled off-chain job (daily or weekly) should:

1. Scan Tier 1 keys that have not been touched recently.
2. Extend any entry whose TTL is below a safety threshold (e.g., 6 months).
3. Log extensions for operational visibility.

This job can be implemented as a script in `scripts/` or as a cron-triggered
API endpoint restricted to admin callers.

### Restoration workflow

If an entry is accidentally archived before extension:

1. Detect via a failed read (returns `None` for a known key).
2. Call `restore_contract_data` with the key and a fresh TTL.
3. Verify the restored value matches expectations (checksum or hash).
4. Alert operators if restoration was needed unexpectedly.

Scripts for restoration should be in `scripts/` and tested against a local
Soroban network with archival enabled.

## Cost Considerations

- Extending a single persistent entry costs a small amount of soroban rent
  units, proportional to the extension duration. For multi-year extensions this
  is negligible relative to the bond's economic value.
- Do not extend all entries blindly. Tier 2 and Tier 3 entries should be
  extended only on mutation or by the keeper job within their natural lifetime.
- The keeper job should batch extensions to amortize transaction overhead.

## Testing

- Unit tests should verify that mutation functions also extend TTL where
  required (mock `env.storage().persistent().extend` calls).
- Integration tests should simulate time passage and verify entries remain
  readable after the simulated archival window.
- The keeper job should have its own test suite covering edge cases:
  already-extended entries, missing entries, and network errors during
  extension.

## Operational Runbook

1. **Before deploying a new bond**: Ensure the BondIssuer admin has funded
   the contract with sufficient XLM to cover storage rent for the bond
   lifetime.
2. **Monthly**: Run the keeper job and verify all Tier 1 entries are extended.
3. **On contract upgrade**: Re-verify that all Tier 1 keys are still present
   and extended in the new contract version.
4. **On restoration**: Investigate root cause — was the keeper job missed?
   Was the bond lifetime miscalculated?
