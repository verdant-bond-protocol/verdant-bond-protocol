# Snapshot Restore Verification (#379)

This proves that a restored snapshot of critical data is complete, satisfies the domain
invariants, and that the derived holder index agrees with it. Every mismatch fails loudly
and comes with a repair step.

Code:

- `api/src/recovery/snapshot-restore-verification.service.ts`: the
  `SnapshotRestoreVerificationService`, registered in `RecoveryModule`.
- `api/scripts/verify-snapshot-restore.ts`: the CLI (`npm run verify:snapshot-restore`).
- Tests: `api/src/recovery/snapshot-restore-verification.service.spec.ts`.

This complements `npm run validate:recovery` (`docs/disaster-recovery-validation.md`).
That command inspects the **live** read model. This one verifies a **snapshot file**
against what was captured, before the restore is put into service.

## Snapshot format

`SnapshotRestoreVerificationService.capture(sections)` produces:

```json
{
  "version": 1,
  "capturedAt": "2026-10-01T00:00:00.000Z",
  "sections": {
    "bonds": [], "projects": [], "orders": [], "kycRecords": [],
    "holdersByBond": { "1": [{ "address": "G...", "balance": "400" }] },
    "settlementTransactions": [{ "txHash": "<64 hex>", "entityType": "subscription", "entityId": "1" }]
  },
  "manifest": { "bonds": { "count": 2, "sha256": "<hex>" } }
}
```

The manifest holds one `{ count, sha256 }` entry per section. Each SHA-256 is taken over the
section's JSON serialisation.

## What verification checks

1. **Integrity (`SNAPSHOT_INTEGRITY`, CRITICAL).** The format version is supported, every
   section is present in both the restore and the manifest, and each section's count and
   SHA-256 match the manifest. This catches truncated restores, partial restores, and silent
   corruption.
2. **Domain invariants (`DOMAIN_INVARIANT`).** These are the existing five invariant groups
   from `DomainInvariantsService`, evaluated against the snapshot only:
   - bond-to-project integrity;
   - supply accounting, including that holder balances sum to `totalSubscribed`;
   - order-book integrity;
   - settlement-hash integrity;
   - KYC integrity.

   `stale` drifts, such as an order that expired after capture, are reported as
   **warnings**. They depend on the time elapsed since capture, not on the restore, and the
   normal expiry jobs clear them.
3. **Derived holder index (`DERIVED_INDEX`).** The holder index
   (`HOLDER_INDEX_PATH`, the `FileHolderStore` file) is a view derived from holder balances.
   Verification rebuilds it from the restored balances:
   - a bond's holders are the addresses with a positive balance, sorted;
   - known addresses are kept;
   - every bond is set to `lastReconciled: 0`.

   It then diffs the rebuilt index against the restored one. It flags holders missing from
   the index (coupon distribution would skip them), listed addresses with no balance, bonds
   that exist only in the index, holders absent from the known-address list, and balances
   that are not integers.

The result is `VERIFIED` only when there are no mismatches. Warnings do not block it.

## Running it

```bash
npm run verify:snapshot-restore -- --snapshot=backups/snapshot.json
npm run verify:snapshot-restore -- --snapshot=backups/snapshot.json --holder-index=.data/holder-index.json --json
npm run verify:snapshot-restore -- --snapshot=backups/snapshot.json --repair
```

Exit codes:

- `0`: verified.
- `1`: mismatches found (each printed with its repair step).
- `2`: the command could not run, for example an unreadable file.

The holder index defaults to `HOLDER_INDEX_PATH`, then `.data/holder-index.json`. A missing
index file is treated as empty, so every holder is reported missing.

The run is **hermetic and read-only**: it reads only the two files, never Redis, the live
KYC store or the ledger. `--repair` is the only write. It replaces the holder index with the
rebuilt one (temp file plus rename, so a crash cannot leave half a file) and then verifies
again.

## Restore procedure

1. Restore the snapshot file and the holder-index file from the same backup set.
2. Run `npm run verify:snapshot-restore -- --snapshot=<file>`. Keep API mutations paused.
3. Act on the result:
   - **Integrity mismatch:** this restore cannot be trusted. Restore again from another copy
     of the backup. Do not repair.
   - **Invariant mismatch:** follow the repair column, which comes from
     `docs/disaster-recovery-validation.md` section 6. Balances that do not add up are
     resolved against the ledger with `npm run reindex-holders`.
   - **Derived-index mismatch:** run with `--repair`, then run
     `npm run reindex-holders -- --bond=<id>` for each bond listed.
4. Re-run until the result is `VERIFIED`, then resume mutations.

The rebuilt index marks every bond as never reconciled. `HolderIndexService` therefore
reconciles each bond against on-chain balances before its next coupon distribution, so a
snapshot that predates later transfers cannot pay the wrong holders.

## Edge cases and failure modes

- **A snapshot taken mid-write.** The supply invariant fails because balances do not add up
  to `totalSubscribed`. Take snapshots from a quiesced replica, or resolve the drift against
  the ledger.
- **Index and snapshot from different backup sets.** The derived-index check reports the
  differences. `--repair` realigns the index to the snapshot, and reindexing realigns it to
  the chain.
- **An older snapshot.** Expired orders and expired KYC show up as warnings, not failures.
- **Format changes.** Bump `SNAPSHOT_FORMAT_VERSION` together with `capture()`. Older
  snapshots are then refused with a clear message instead of being half-verified.

## Complexity

- Capture and the integrity check are O(S) in snapshot bytes.
- The invariants are O(B + H + O + K + T) over bonds, holder entries, orders, KYC records
  and transactions.
- The rebuild is O(H log H) because of the sort. The index diff is O(H) using sets.

## Rollback

The service and CLI are additive. To remove them, take out the provider in
`RecoveryModule` and the `verify:snapshot-restore` script. `--repair` changes only the
holder-index file. Back that file up first if you may want to roll a repair back, then copy
the backup over it. `npm run reindex-holders` rebuilds the index from the chain in any case.
