# Dispute Lifecycle (#625)

`api/src/disputes/dispute-lifecycle.ts` handles a dispute from start to finish. A holder (the **claimant**) disputes an amount owed by a counterparty (the **respondent**) on a bond. The disputed amount is held while the dispute runs. Each party can submit evidence until a deadline, then an **arbiter** rules. When the dispute ends, the held amount is paid out exactly once.

```
open ──(evidence deadline, sweep)──▶ under_review ──(arbiter ruling)──▶ resolved
  │                                       │
  │                                       └──(resolution deadline, sweep)──▶ expired
  └──(claimant withdraws, any time before a final state)──▶ withdrawn
```

`resolved`, `withdrawn` and `expired` are final.

## Operations

| Operation | Who | When |
|---|---|---|
| `open(actor, input)` | any authenticated user (who becomes the claimant) | at most one active dispute per claimant and subject |
| `get(actor, id)` | claimant, respondent, arbiter, admin | any time |
| `submitEvidence(actor, id, input)` | claimant or respondent | before `evidenceDeadline` |
| `resolve(actor, id, ruling)` | an `arbiter` who is not a party | from `evidenceDeadline` until just before `resolutionDeadline` |
| `withdraw(actor, id)` | claimant | any time before a final state |
| `sweep(actor)` | `admin` | run on a schedule |

Defaults: a 7-day evidence window, then a 14-day review window, and at most 20 evidence items per party. All three are configurable.

Rulings:

- `upheld` pays the whole amount to the claimant.
- `rejected` pays the whole amount to the respondent.
- `split` pays `toClaimant` to the claimant and the rest to the respondent.

Withdrawal and expiry both return the whole amount to the respondent, which leaves things as they were before the dispute.

## Financial invariants

1. **Conservation.** Every payout satisfies `toClaimant + toRespondent === amount`, with both sides non-negative (`assertConserved`). The check runs before anything is written and again before the ledger is called.
2. **Hold once, settle once.** `open` places one hold. Each dispute reaches the ledger's `settle` with exactly one split, however many retries, sweeps or concurrent callers are involved.
3. **Integer stroops.** Amounts are positive integer strings handled as `bigint`, with no floating point. Each amount is capped by `maxAmount`, which defaults to 10^18.

### How settlement stays exactly-once

Settlement happens in two phases:

1. The intended split is written to the dispute as `pendingSettlement`, using compare-and-set on `version`.
2. The ledger's `settle` is called. Then the final status is written and `pendingSettlement` is cleared.

Only one finalization can win step 1. If a ruling, a withdrawal and an expiry race, the losers get `conflict` and move no money. While `pendingSettlement` is set, no other split can start, and new evidence is refused.

## Errors

Every error is a `DisputeError` with a `code`. `retryable` is true for `conflict`, `hold_failed` and `settlement_failed`.

| Code | Meaning |
|---|---|
| `forbidden` | not authenticated, or the wrong role or party |
| `invalid` | bad input, a split that does not conserve the amount, or the evidence limit is reached |
| `not_found` | unknown dispute id |
| `conflict` | an idempotency key was reused with a different payload; another active dispute exists on the subject; a concurrent write won; or a different settlement is in progress |
| `invalid_state` | the operation is not allowed in the current state (for example, ruling while the evidence window is open, or adding evidence after a final state) |
| `deadline_passed` | evidence after `evidenceDeadline`, or a ruling at or after `resolutionDeadline` |
| `hold_failed` | the ledger refused the hold, or a compensating release failed |
| `settlement_failed` | the ledger's `settle` failed; the intent is kept so the settlement can be finished later |

## Retry and recovery

| Failure | State afterwards | Recovery |
|---|---|---|
| The hold fails during `open` | nothing stored, nothing held | retry `open` with the same key |
| The hold succeeds but the dispute write fails | the hold is released (compensation), nothing stored | retry `open` |
| The write fails **and** the release fails | `hold_failed` whose message includes `reconcile hold <id>` | an operator releases that hold in the ledger, or retries `open` with the same key (the hold is idempotent per dispute id, so it is reused) |
| Two identical `open` calls race | the loser sees the winner's record and returns it; the hold is kept | none needed |
| `settle` fails during a ruling, withdrawal or expiry | status unchanged, `pendingSettlement` set | repeat the same call, or let `sweep` finish it. `sweep` finishes a pending settlement even after the resolution deadline, so an accepted ruling is never replaced by an expiry |
| The final write fails after `settle` succeeded | `pendingSettlement` still set | the next retry or `sweep` calls `settle` again with the **same** split (the ledger must treat this as a no-op), then writes the final state |
| A write loses compare-and-set | `conflict`, no side effects | re-read and retry |
| One dispute fails inside `sweep` | listed in `report.failed`; the others are still processed | the next `sweep` picks it up |

Idempotent retries:

- **`open`:** the same claimant and key return the same dispute. The dispute id is derived from `sha256(claimantId, key)`, so keys are scoped to each claimant and one user cannot collide with another.
- **Evidence:** the same party resubmitting the same `contentHash` returns the existing item, even after the window has closed. The other party may submit the same hash as its own item.
- **`resolve`:** repeating the same ruling returns the stored result. A different ruling gets `conflict`.
- **`withdraw`:** repeating it is a no-op.

## Edge cases

- A claimant cannot open a dispute against themselves. An arbiter who is a party to the dispute cannot rule on it, even with the `arbiter` role.
- Deadlines are enforced from the clock on every call, not only by `sweep`. A ruling at or after `resolutionDeadline` is refused even if the sweep has not yet marked the dispute expired. The `open` → `under_review` status change is informational; rulings are gated by time.
- Boundaries are exclusive: evidence submitted exactly at `evidenceDeadline` is refused, and a ruling is allowed from that moment.
- A claimant can open a new dispute on the same subject once the previous one is final.
- Evidence must be a sha256 hex digest or an IPFS CID. Only the hash is stored, not the document. Descriptions and reasons are capped at 2000 characters.

## Ports required by a production deployment

- `DisputeStore` must provide compare-and-set on `version`, where an expected version of `0` means "must not exist". `InMemoryDisputeStore` is the reference implementation used by the tests.
- `SettlementPort` methods `hold`, `release` and `settle` must be idempotent per dispute id.

## Migration

The module is new and additive: it adds no routes, no contract changes and no changes to existing tables. Wiring it into a NestJS controller and a durable store can be done separately without changing these semantics.

## Verification

`api/src/disputes/dispute-lifecycle.spec.ts` contains 54 tests covering the normal, deadline, validation, authorization, retry, failure and recovery paths, plus the conservation and settle-once invariants.

```
cd api && npx jest src/disputes
```
