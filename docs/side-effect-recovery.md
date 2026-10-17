# Recovery checkpoints around external side effects

Issue: [#405](https://github.com/verdant-bond-protocol/verdant-bond-protocol/issues/405)

`SideEffectCheckpointService` (`api/src/recovery/side-effect-checkpoint.service.ts`)
wraps **every external side effect** — an on-chain submission, a webhook, an
email, a third-party write — in a durable checkpoint so an interrupted or
ambiguously-failed effect can be repaired deterministically instead of being
blindly retried.

## The problem

The dangerous case is an **ambiguous failure**: the request may or may not have
been applied before the timeout. Re-running a non-idempotent effect
(double-apply) and skipping it (permanent gap) are both wrong. The checkpoint
records enough state to decide.

## State machine

```
started ──execute ok──────────────▶ applied
   │
   ├──execute err (probe = false)──▶ failed   (safe to retry)
   │
   ├──execute err (probe = true)───▶ verified (already applied; never re-run)
   │
   └──execute err (probe throws)───▶ unknown  (operator must resolve)
```

| State      | Meaning                                             | Resume behaviour                          |
| ---------- | --------------------------------------------------- | ----------------------------------------- |
| `started`  | Intent recorded, outcome not yet known.             | Probe → `verified`/re-run.                |
| `applied`  | Effect confirmed done.                              | No-op (idempotent).                       |
| `verified` | Probe confirmed a previously-ambiguous effect.      | No-op.                                    |
| `failed`   | Effect did **not** land.                            | Re-run.                                   |
| `unknown`  | Ambiguous and unprobed (or the probe failed).        | Left for an operator; **never** re-run without a probe. |

## API

```ts
// Wrap a single effect.
const checkpoint = await checkpoints.run({
  key: 'payout:batch-42:holder-7',   // idempotency key
  description: 'Settle holder 7',
  execute: () => chainClient.pay(holder),
  probe: () => chainClient.hasPaid(holder), // resolves ambiguous failures
  context: { batchId: 42, holder },
});
checkpoint.state; // 'applied' | 'verified' | 'failed' | 'unknown'

// Repair later (e.g. on a scheduled sweep or from an admin tool).
await checkpoints.resume('payout:batch-42:holder-7', execute, probe);

// Inspect what still needs attention.
await checkpoints.getPending(); // started + unknown
```

`run` **never throws**; the outcome is always in the returned checkpoint's
`state`. `resume` is idempotent and safe to call repeatedly.

## Durability

Checkpoints are written through to Redis (`sideeffect:<key>`, 30-day TTL) so
they survive a process restart, with an in-process map as the fast path and
fallback when Redis is unavailable. A restart therefore rehydrates the
outstanding work list via `getPending()`.

## Operational edge cases and recovery

- **Redis unavailable** — the checkpoint still exists in-process; when Redis
  returns, subsequent writes re-mirror it. During an outage, `getPending()`
  reflects only this process's view.
- **Probe also down** — the checkpoint stays `unknown`; retrying is blocked so
  a partial outage cannot cause a double-apply. Provide a probe or resolve
  manually.
- **Double-apply safety** — `run`/`resume` never execute a side effect whose
  checkpoint is `applied`/`verified`.
- **Rollback** — checkpoints are additive metadata keyed by an idempotency key;
  removing the feature leaves underlying effects untouched.

## Testing

`api/src/recovery/side-effect-checkpoint.service.spec.ts` covers the normal,
failure, ambiguous-with-probe (applied/not-applied/probe-down), retry,
idempotent-resume, unknown-without-probe, persistence, and listing paths.
