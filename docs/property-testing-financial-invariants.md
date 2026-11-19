# Property tests for financial and ownership invariants

**Scope (vertical slice):** the holder-index / subscription accounting model —
the subscription ceiling (INV-001), positive holder balances (INV-004),
conservation of subscribed tokens (INV-005), and valid holder addresses
(INV-006), plus the two access-control invariants (INV-007/INV-008).

## What was added

| File | Purpose |
|------|---------|
| `api/src/common/invariants/property-harness.ts` | Seedable Mulberry32 PRNG, `checkProperty`/`assertProperty`, greedy shrinking to a minimal counterexample. No new dependency. |
| `api/src/common/invariants/financial-ownership.properties.ts` | Reference model of a holder transfer, seeded generators, shrinkers, and helpers that run the **production** invariant functions against generated states. |
| `api/src/common/invariants/financial-ownership.property.spec.ts` | 18 executable properties over the normal / failure / retry / authorization paths. |

Run with:

```sh
cd api && npx jest --runInBand src/common/invariants/financial-ownership.property.spec.ts
```

A failure prints the seed, the number of cases before failure, the number of
shrink steps, and a JSON counterexample. Re-run with that seed to reproduce it
exactly — no `Math.random()` is used anywhere in the harness.

## Paths covered

- **Normal:** generated states are valid; a legal transfer moves exactly the
  requested amount and conservation, positivity, the supply ceiling and address
  validity all still hold.
- **Failure:** overdraws and non-positive amounts are rejected without mutating
  state; deliberate drift (token creation, token loss, zeroed balance) is
  detected by INV-005 / INV-004.
- **Retry:** a replayed idempotency key is a no-op; a rejected overdraw succeeds
  once after the amount is corrected; re-running a deliberately failing
  property with the same seed reproduces the same shrunken counterexample.
- **Authorization:** only the holder or the bond admin may move a balance;
  INV-007 and INV-008 agree with generated actor/admin/KYC combinations.

## Edge cases

- **Full precision:** balances above `Number.MAX_SAFE_INTEGER` use `bigint`
  end-to-end; a `2n ** 100n` transfer is verified to be exact.
- **Zero-balance holder:** a holder whose balance reaches zero is removed from
  the index; leaving a zero entry behind would violate INV-004.
- **Self-transfer:** treated as an applied no-op; it must not zero the holder
  or change `totalSubscribed`.
- **Empty holder index:** `{}` with `totalSubscribed = 0` is a valid state;
  a transfer against it is rejected.
- **Cached-total drift:** `corrupt()` changes a holder balance *without*
  recomputing `totalSubscribed`, modelling a stale cache or a missed ledger
  write — the case the reconciliation job exists to catch.
- **Immutability:** `applyTransfer` never mutates its input, so the model can be
  used to assert that a failed/rejected operation leaves state untouched.

## Recovery / rollback behavior

These properties are **read-only verification**: they operate on generated in
memory reference states and never touch live Redis, Postgres or Soroban state.
There is nothing to roll back. The recovery semantics they verify are the ones
the production code must provide:

- a rejected transfer leaves the input state untouched (discard the result —
  that is the rollback);
- a duplicate idempotency key leaves the state untouched (safe retry);
- when a real invariant breach is found by reconciliation, the operator follows
  the existing holder-index reindex runbook (`docs/runbook-holder-reindexing.md`)
  rather than mutating balances ad hoc.

## Contract compatibility / migration

No production API, storage schema or on-chain contract is changed. This is an
additive test-only slice, so **no migration is required**. The property model
documents the existing contract rather than redefining it; if a future change
alters transfer rules, update `financial-ownership.properties.ts` in the same
PR as the implementation so the two cannot drift.
