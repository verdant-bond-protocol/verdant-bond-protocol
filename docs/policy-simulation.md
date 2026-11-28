# Policy Simulation and Affected-Record Preview

Issue: [#578](https://github.com/verdant-bond-protocol/verdant-bond-protocol/issues/578)

`PolicySimulationService` (`api/src/policy/policy-simulation.service.ts`) provides a
non-mutating, read-only simulation pipeline that previews the impact of proposed policy
changes (such as subscription minimums/maximums, holding limits, and restricted
jurisdictions) against historical candidate records before changes are committed.

## The Problem

Modifying global protocol policies directly in production creates operational and financial
risk. An administrative change (e.g. raising the minimum investment threshold or adding a
jurisdiction restriction) could inadvertently disqualify active subscribers or block pending
secondary market transactions. Operators need a deterministic pre-flight check that models the
blast radius without mutating live protocol configuration.

## Architecture & Data Flow

```
                      +-----------------------------+
                      |    PolicySimulationInput    |
                      | (proposedConfig, userRole,  |
                      |      target records)        |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |   Authorization & Validation|
                      |  (Role check, range check)  |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |  Live Policy State Snapshot |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |   Differential Evaluation   |
                      | (evaluateWithConfig overlay)|
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      | Outcome Comparison & Diffs  |
                      |   (Status flips, violations)|
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |  Immutability Invariant     |
                      | (Verify live state untouched|
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |    PolicySimulationResult   |
                      |   (affectedCount, examples, |
                      |         riskWarnings)       |
                      +-----------------------------+
```

## API & Semantics

```ts
const result = simulationService.simulatePolicyChange({
  userRole: 'MAINTAINER', // Required: 'MAINTAINER' or 'ADMIN'
  proposedConfig: {
    minSubscriptionAmount: BigInt('10000'),
    restrictedJurisdictions: ['US', 'KY'],
  },
  records: candidateRecords, // Optional: defaults to representative historical sample
});

result.isReadOnlyConfirmed; // true
result.totalEvaluated;      // total records processed
result.affectedCount;       // records with status flips or new rule violations
result.unaffectedCount;     // records whose outcomes remain identical
result.affectedExamples;    // detailed before/after comparison per affected record
result.riskWarnings;        // e.g. "High Impact Warning: 40% of records affected"
```

## Paths Covered by Tests

* **Normal Path**: Evaluates proposed configuration overlays against candidate records,
  identifies status flips (`APPROVED` $\leftrightarrow$ `DISAPPROVED`), collects newly
  triggered rule violations, calculates percentage-based risk heuristics, and confirms
  `isReadOnlyConfirmed === true`.
* **Failure Path**: Non-maintainer/admin callers are rejected with `403 ForbiddenException`.
  Configurations violating invariants (e.g. `minSubscriptionAmount > maxSubscriptionAmount`)
  are rejected with `400 BadRequestException`. Any detected mutation to live configuration
  aborts with an error.
* **Retry Path**: The simulation is pure and side-effect free. Retries produce identical,
  deterministic diffs without cumulative state or performance degradation.
* **Authorization Path**: Scoped exclusively to administrative and maintainer roles.

## Edge Cases & Operational Considerations

* **Read-Only Invariant**: Before returning, the service serializes `currentConfig` and
  `postSimulationConfig` (handling `BigInt` safely via string transformation) to guarantee
  that zero production state was modified.
* **Default Dataset Fallback**: When `records` is omitted, the service falls back to a curated
  dataset covering diverse jurisdictions and investment amounts.
* **BigInt Safety**: Financial boundaries (e.g., $10^{12}$ stroops/units) are compared using
  native `BigInt` to prevent 64-bit float precision loss.
* **Rollback Behavior**: Simulation writes no persistent state to PostgreSQL, Redis, or
  Stellar ledger; rollback is a strict no-op.

## Contract Compatibility & Migration

The simulation engine is additive and operates on in-memory configuration overlays. No
smart contract ABIs, database schemas, or existing controller endpoints are mutated.

