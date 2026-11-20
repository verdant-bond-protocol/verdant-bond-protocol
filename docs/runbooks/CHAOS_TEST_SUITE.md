# Deterministic Chaos Test Suite (#348)

`api/src/test/chaos.spec.ts` injects faults into the two workflows that most
often get interrupted:

- the **user workflow**: an `Idempotency-Key` protected mutation, such as a
  coupon claim or subscription;
- the **background workflow**: `JobQueueService` and `WorkerService`.

```bash
cd api && npx jest src/test/chaos.spec.ts
```

## How it stays deterministic

- **Real services, fake transport.** `ChaosRedisClient` (`api/src/test/chaos.harness.ts`)
  replaces the socket underneath the real `RedisService`. That means the
  production degrade behaviour is exactly what runs: `get` returns `null`,
  `setNx` returns `false`, and writes fail silently.
- **Seeded faults.** Every fault comes from a seeded PRNG (`seededRandom`,
  `randomFaults`). A failing seed (`seed 1013`) replays identically. Re-run it
  with `-t "seed 1013"`.
- **No clocks.** There are no sleeps or wall-clock timeouts. TTLs run on a
  manual clock (`client.advance(ms)`). `settle()` drains the microtask queue
  through `setImmediate`. The worker's five-minute timeout timer is faked and
  never fires.
- **Restarts are fresh service graphs** over the same store. Durable state is
  only what Redis holds, as in production.

## Fault model

| Fault | Meaning | Injected where |
|-------|---------|----------------|
| `fail` | Connection reset before the command reaches Redis | any Redis op |
| `lostAck` | Write committed, but the reply is lost | Redis writes |
| `stale` | Read returns the value before the last write (replica lag) | Redis reads |
| crash | Process dies mid-handler; claims and pending records remain | handlers |
| restart | New process, nothing in memory | every round / step |
| network failure | Chain submit or RPC fails before the effect, or after commit (timeout) | handlers |
| retries | Concurrent duplicate requests and post-error retries | user workflow |

## Invariants asserted (25 seeds per workflow)

**User workflow**

1. **No overlapping executions.** No two executions for one key ever overlap.
2. **No execution after success.** No execution starts once a `success` record
   exists.
3. **One result per key.** Every client that receives `200/201` for a key gets
   the same body.
4. **Convergence.** Once faults stop and the runbook step below has run,
   every key converges to the transaction that actually landed on the ledger.

**Background workflow**

1. **No overlapping executions.** No job runs on two workers at once.
2. **No re-run after a terminal status.** No job runs after `success` or
   `dead_letter`.
3. **Termination.** Every job ends up terminal. The queue drains, and
   `getDeadLetterJobs` lists exactly the dead letters.

Named scenarios pin each behaviour individually, including a crash followed by
redelivery that happens only after the lock TTL.

## Bugs this suite found (fixed in the same change)

| Bug | Fix |
|-----|-----|
| Concurrent retries after an `error` all executed | `IdempotencyService.claimRetry`: an atomic claim; re-checks the record is still `error` |
| Unreadable record after a failed reservation executed without dedup | Interceptor fails closed with 409 |
| Lost ack on the reservation wedged the key as "in progress" | Owner token in the pending record |
| A failed read inside `complete()` stored an empty fingerprint, so every retry got 409 for 24h | Interceptor passes the fingerprint to `complete()` |
| Removal from the queue was `sAdd` (a no-op), so finished jobs re-ran forever | `RedisService.sRem`; the job stays queued until terminal; the lock is the claim |
| A failed status write still dropped the job from the queue, losing it | Queue membership is only removed after the status write is confirmed |
| A late worker could overwrite a finished job | `markSuccess` and `markFailure` ignore jobs that are already terminal |

## Behaviour changes (API compatibility)

- **Idempotent routes during a Redis outage.** A request with an
  `Idempotency-Key` now gets `409 Idempotency state unavailable; retry with the
  same Idempotency-Key`. Previously the mutation ran without deduplication.
  Requests without the header, and routes not marked `@Idempotent`, are
  unchanged. Clients should already retry 409s with the same key, as they do
  for "in progress".
- **Concurrent retries after an error.** Exactly one runs; the rest get the
  existing "already in progress" 409.
- **Dead-letter storage.** Dead letters now live in a separate
  `job:dead-letter` set. **Migration:** legacy dead letters still in
  `job:queue` move to the new set the first time any worker sweeps past them.
  No manual step is needed. The response shape of the dead-letter listing (`GET /api/v1/jobs/dead-letter/list`) is
  unchanged.
- **Queue size.** `getQueueSize` now counts pending and in-flight jobs.
  Previously it counted every job ever enqueued.

## Operational edge cases and recovery

### Wedged pending idempotency key

**Symptom.** A client keeps receiving `409 already in progress` long after the
original request ended. The process crashed between reserving and recording
the result, or the completion write failed.

**Recovery.** Never re-execute blindly. The effect may have landed.

1. Read `idem:<key>`. If `status` is `pending` and the request is older than
   the client timeout, treat it as wedged.
2. Look up the ledger: find the transaction for that operation by its signed
   tx hash or nonce.
3. **If it landed,** write the success result with the real
   `transactionHash`. In code this is
   `IdempotencyService.complete(key, 'success', result, 201, fingerprint)`.
4. **If it did not land,** `DEL idem:<key> idem:<key>:retry`. The client's
   next retry runs it.

The suite exercises exactly this procedure (`operatorRecover`).

### Retry claim left behind

`idem:<key>:retry` expires after `RETRY_CLAIM_TTL_SECONDS` (60s). Retries get
409 until it does. No action is needed.

### Worker crash mid-job

The job stays queued under `job:processing:<id>`. After
`PROCESSING_LOCK_SECONDS` (600s, longer than the 5-minute job timeout) any
worker can claim it again. Delivery is at-least-once: handlers must be
ledger-idempotent.

### Redis outage

- **Queue.** `dequeue` throws (`getOrThrow`), and the worker loop backs off.
  No job is dropped.
- **Idempotent routes.** Return 409 (see the API compatibility section above).
- **Restore.** Bring Redis back. Nothing else is needed.

### Rollback

All changes are code-only. There are no schema changes, and the only new Redis
keys are `job:dead-letter` and `idem:*:retry`. Reverting the release restores
the previous behaviour, including its double-execution bugs. If you revert,
run `SMEMBERS job:dead-letter` first and re-add those ids to `job:queue` if
the old dead-letter listing must keep showing them.
