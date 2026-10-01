# Deterministic Recovery (Issue #261)

Multi-step operations — bond subscription, coupon distribution, on-chain
settlement followed by webhook notification — must survive interruption at any
point: a wallet action that never arrives, an API call dropped mid-flight, a
worker that dies, a browser session closed between steps.

## The problem being solved

The naive retry is dangerous. If step 2 ("submit to chain") succeeded on chain
but the process died before recording that, replaying steps 1–2 double-submits;
skipping straight to step 3 records a notification for a settlement nobody can
prove happened. Recovery therefore needs to know **exactly which steps are
known complete**, and for steps with irreversible external effects, **whether
that effect actually landed**.

## Determinism contract

For a given `(operationId, lastCheckpoint)` pair, `resume()` always performs
the same steps in the same order and never re-executes a step whose side effect
is already applied. Concretely:

1. the step list is copied at `start()` and never mutated, so step order cannot
   drift between the original run and a resume days later;
2. `resume()` starts at the **last checkpoint's index**, so completed steps are
   never replayed;
3. a step declaring `hasExternalSideEffect` first calls `sideEffectsApplied()` —
   if the effect landed, the step is checkpointed complete **without running**;
4. each step records a checkpoint atomically after it finishes, carrying the
   state needed to continue.

## State machine

```
NOT_STARTED → RUNNING → COMPLETED
                │  ▲
                ▼  │ resume()
           INTERRUPTED
                │  ▲
                ▼  │ resume()
            RECOVERING ──→ COMPLETED
                │
                └──→ ABANDONED (operator decision only)
```

`INTERRUPTED` is the only status an application error produces, and it always
stops the run: nothing after the failing step executes. This is what makes
"resume or fail safely without duplicate side effects" true — an operation is
either fully resumed from its checkpoint, or stopped exactly where it broke.

## Interruption timing

The spec covers all three windows:

| Interruption window | What happens on resume |
|---|---|
| **Before** a side effect (step failed outright) | Checkpoint records the failing step; nothing irreversible happened; resume re-runs it |
| **During** a side effect (connection reset mid-submission) | `sideEffectsApplied()` arbitrates: effect landed → skip forward; effect unknown/not landed → re-run the step |
| **After** a side effect (chain accepted, process died before checkpoint) | `sideEffectsApplied()` returns true, so the already-landed effect is *not* repeated and the run continues to the next step |

## User-visible recovery

`RecoveryUserAction` records, at interruption time, the operation, the step
that failed, and the next action for the user (`retry <step>` by default, or a
step-specific `userAction` string). Surfaced at `GET
/api/v1/recovery/:operationId/actions` so a user returning to a half-finished
subscription sees "retry submit_onchain then continue" instead of a dead form.

## Maintainer diagnostics

`GET /api/v1/recovery/diagnostics` (admin) lists every non-terminal operation:

- `stepId` / `stepIndex` — where it stopped,
- `interruptedForMs` — how long it has been sitting there,
- `resumeAttempts` — how many times resume was attempted,
- `lastError` — why it stopped.

`POST /api/v1/recovery/:operationId/abandon` is the explicit operator decision
to give up on a stuck operation. It is refused for operations younger than the
`olderThanMs` threshold (default 24h) and for operations that already
completed; an abandoned operation cannot be resumed, which prevents a stale
half-applied operation from being replayed silently weeks later.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/recovery/:operationId/resume` | JWT | Resume from last checkpoint (idempotent) |
| `GET` | `/recovery/:operationId` | JWT | Full operation state |
| `GET` | `/recovery/:operationId/actions` | JWT | User-facing next steps |
| `GET` | `/recovery/diagnostics` | Admin | Stuck / abandoned operations |
| `POST` | `/recovery/:operationId/abandon` | Admin | Abandon a stuck operation |

## What is *not* covered

- **Durable checkpoint storage.** Checkpoints live on the service instance.
  A crash that loses the process also loses them, which is why recovery here
  covers interruption of the *logical* operation (a step threw, a dependency
  was down, a caller aborted) rather than process death. Persisting
  checkpoints to Redis/Postgres is the natural next step once a storage
  interface is agreed — the state machine and step contract do not change.
- **Automatic compensation.** Interrupted operations are surfaced, never
  auto-reversed. Undo of an applied side effect is an operator decision, not
  something this module infers.
