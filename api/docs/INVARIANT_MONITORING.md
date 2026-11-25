# Invariant monitoring for balances and ownership

`src/common/invariants/domain-invariants.ts` defines the checks (supply vs.
subscribed, holder balances, holder addresses and so on).
`src/common/invariants/invariant-monitor.ts` runs them as a monitor that tracks
their health over time and raises alerts. The behaviour is covered by
`invariant-monitor.spec.ts`.

## Usage

```ts
const monitor = new InvariantMonitor(
  [
    { id: 'subscribed-within-supply', check: () => bondLifecycleInvariants.subscribedDoesNotExceedSupply(sub, supply) },
    { id: 'holder-balances-sum', check: () => bondLifecycleInvariants.holderBalancesSumEqualsTotalSubscribed(balancesByHolder, sub) },
  ],
  { alertThreshold: 2, onAlert: (alert) => pager.send(alert) },
);

const report = await monitor.run(adminActor); // call from a scheduler
monitor.status(adminActor);                    // last known state, runs nothing
```

## Outcomes of a check

| Outcome | Meaning | Health | Retried |
|---|---|---|---|
| Passes | The invariant holds | `healthy` | no |
| Violation | The check ran and the data breaks the rule | `violated` | **no**, it is a result |
| Error | The check could not run: it threw or timed out | `errored` | yes, up to `maxAttempts` (default 2) |

A check that has not run yet is `unknown`. Violations and errors are kept
apart on purpose: "the data is wrong" and "we could not look" need different
responses.

## Alerts

| Alert | When |
|---|---|
| `violation` | A check starts violating, after `alertThreshold` consecutive bad runs (default 1) |
| `check_error` | A check starts erroring, on the same threshold |
| `recovered` | A check that had alerted passes again |

Each is raised once per episode, not once per run, so a persistent violation
does not page every interval. Moving from `violated` to `errored` (or back)
raises a new alert. A bad run that never reached the threshold is not
announced as a recovery. `consecutiveFailures` and `lastViolatedAt` stay on the
status so the history is visible after recovery.

## Edge cases

- **Hung check:** each attempt is limited by `timeoutMs` (default 5000); the
  other checks still run.
- **Broken alert sink:** an exception from `onAlert` is counted in
  `alertErrors` and never stops the run or the other alerts.
- **Overlapping runs:** a `run` call made while one is in flight returns that
  run's report; checks are not run concurrently with themselves.
- **Configuration:** duplicate or blank ids and non-positive options are
  rejected when the monitor is built.
- **Attribution:** a check that throws is reported under its registered id.
  The plain `runAllInvariants` reports those as `Unknown`.

## Authorization

`run` and `status` require an actor with `isAdmin: true` and throw
`InvariantMonitorError('forbidden')` otherwise, before any check is invoked.
Status objects are copies; callers cannot alter monitor state.

## Recovery and rollback

The monitor only reads: it never repairs data and has nothing to roll back.
When it reports a violation, fix the data (or the cached view) and the next run
reports `recovered`. State is held in memory and is lost on restart; every check
starts as `unknown` and the next run rebuilds it, though a violation that is
already present will alert again.

## Not covered here

- Scheduling the runs, persisting status, and exposing it over HTTP.
- Choosing the real inputs for each check (they come from the bond and holder
  services); this module takes them as closures.
