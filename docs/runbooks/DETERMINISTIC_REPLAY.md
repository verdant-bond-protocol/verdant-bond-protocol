# Deterministic Replay Tests for Concurrent Writes and Retries (#390)

`api/src/test/replay/` turns the **interleaving** of concurrent actors into a
reproducible test input. The chaos suite ([CHAOS_TEST_SUITE.md](CHAOS_TEST_SUITE.md))
does the same for faults.

```bash
cd api && npx jest src/test/replay                       # 25 seeds per scenario
REPLAY_SEED=2021 npx jest src/test/replay                # one seed
```

## How it works

`ReplayScheduler` (`replay-scheduler.ts`):

1. Each actor (an API instance, a worker or a submitter) gets its own
   `RedisService` over a `gatedClient`. Every Redis command first parks on
   `scheduler.gate(actor, op)`. The test can gate external effects the same
   way, for example `chain.submit` or a job `handler`.
2. When every live actor is parked, the scheduler releases **exactly one**.
   It picks from the sorted set of runnable steps, so the choice depends only
   on what is runnable, never on arrival order:
   - **explore mode** (`{ seed }`): a seeded PRNG picks;
   - **replay mode** (`{ trace }`): the recorded label must be runnable at
     that step. If it is not, the run fails with `ReplayDivergenceError`,
     naming the step, the expected label and what was runnable.
3. Each release is appended to `scheduler.trace` as `actor#n:op`.
   `onStep` runs after every step, so an invariant fails at the first bad
   state rather than at the end.
4. Lock-retry sleeps and `Retry-After` waits use Jest's fake clock. The clock
   only advances when no actor is runnable. `crypto.randomUUID` is replaced
   with a counter, so job ids and lock tokens match between runs.
5. An actor that can never be scheduled again is reported as `hung` rather
   than hanging the test.

Faults still come from the chaos harness (`ChaosRedisClient.plan`) and from
per-actor seeded streams. A fault decision therefore never depends on the
interleaving.

## Scenarios and invariants

### Nonce allocation (`NonceService.withNonce`)

Four submitters race for one account's sequence. The simulated chain fails
before commit (20 %), times out after commit (15 %) or succeeds. Each caller
retries up to 3 times. A retry of a payment that already landed consumes its
sequence number but never pays twice.

- No two submits overlap under the nonce lock.
- No `tx_bad_seq`: a stale cached cursor is never used.
- Sequence numbers are consumed in order (`0..n-1`, with no gap and no reuse).
- After rollback or resync, the cached cursor equals chain truth and the lock
  is free.
- Failure path: losing Redis while taking the lock surfaces `503` and never
  double-allocates.

### Bounded queue admission and processing (#391)

Three API instances enqueue exports concurrently: two for `alice`, one for
`bob`. Bounds are `data_export` 3 and 2 per user. An admin enqueues with the
privileged reserve, and two workers drain the queue while 30 % of handler runs
fail and are retried. Clients honour `Retry-After` and give up after 3 tries.

- At **every step**: type depth ≤ bound + reserve, and no user holds more than
  the per-user bound.
- The admin's privileged submissions are always admitted (authorization path).
- Rejections only ever name a real scope. Nothing rejected is persisted.
- No job runs on two workers at once, and none runs after a terminal status.
- Every admitted job is queued or terminal, and terminal jobs are out of the
  admission indexes. The admission lock ends free.

### The mechanism itself

- One seed reproduces the same trace and a byte-identical final store
  (`ChaosRedisClient.snapshot()`).
- A recorded trace replays to the same final store.
- Different seeds explore different interleavings.
- A tampered or outdated trace fails with `ReplayDivergenceError`.

The suite was checked against deliberate regressions. Removing the nonce lock
fails every nonce seed with overlapping submits. Removing the admission lock
lets seed 2021 put 3 jobs on a user bounded at 2.

## Working with a failure

A failing seed prints its replay trace:

```
seed 2021: user alice holds 3 > 2 pending jobs
replay trace: ["admin#1:set","api-1#1:set", ...]
```

1. Re-run it alone: `REPLAY_SEED=2021 npx jest src/test/replay`.
2. To pin the regression, copy the trace into a test that runs the scenario
   with `{ trace: [...] }`. This replays the exact interleaving even if the
   PRNG or the seed list changes later.
3. Fix the code. If the fix changes which Redis commands run, the pinned
   trace stops matching and fails with `ReplayDivergenceError`. This is
   expected: re-record it from the seed once the invariant holds.

## Edge cases and limits

- **Granularity is one Redis command.** A race inside one command (Redis is
  single-threaded) or inside synchronous JS between two awaits is not
  explored. This matches what can actually interleave in production.
- **Traces are tied to the code.** Any change to the sequence of Redis calls
  invalidates recorded traces. Seeds keep working, but explore a different
  schedule. Prefer seeds in CI and pinned traces for specific regressions.
- **Crash or restart** is covered by the chaos suite. Here, an actor that
  stops issuing commands is reported `hung` and its locks run out on the
  harness clock.
- **No production code paths are changed for testing.** The scheduler sits
  under the real `RedisService`, as the chaos harness does. The only
  production hook is `JobQueueService.pause`, a protected sleep.
