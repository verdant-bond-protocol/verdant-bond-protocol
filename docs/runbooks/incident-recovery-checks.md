# Incident Recovery Runbook Checks

`executeIncidentRecoveryChecks` (`api/src/recovery/incident-recovery-runbook-checks.ts`) provides automated pre-flight and post-recovery verification for incident drills and recovery operations:

1. **Authorization & Safety**: Requires `actorRole === 'operator'` and explicit `allowProduction: true` when targeting `production`.
2. **Dependency Probes**: Checks PostgreSQL, Redis, and Soroban RPC health with configurable transient retries.
3. **Backlog Verification**: Verifies that pending partial-settlement/recovery items do not exceed `maxPendingRecoveries`.

## Verification

```bash
npm test -- src/recovery/incident-recovery-runbook-checks.spec.ts
```
