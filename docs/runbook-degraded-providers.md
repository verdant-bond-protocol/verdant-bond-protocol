# Runbook: Degraded Oracle Providers

With staking and slashing live on `OracleConsumer`, the protocol has a real
economic stake in provider reliability. This runbook covers how to observe
provider health, what alerts mean, and how to respond.

## Observability surface

| Signal | Where | Description |
|--------|-------|-------------|
| Adapter health | `oracle` monitor, `GET /health` | Per-adapter upstream probe: `up` / `degraded` / `down` + latency |
| Report staleness | API, `GET /oracle/monitoring/staleness` | Per-project and per-provider time since last verified report vs. expected window |
| Provider stats | API, `GET /oracle/stats/:providerAddress` | Reports submitted, challenges faced, slash history (from chain) |
| Oracle incidents | API, `GET /oracle/incidents` (admin) | Durable, queryable record of every stale project/provider: active, acknowledged, or resolved, with occurrence count and severity |

### Starting the oracle monitor

```bash
cd oracle
npm run monitor            # starts http server on $ORACLE_MONITOR_PORT (default 8080)
```

Endpoints:

- `GET /health` — health check per adapter (Verra registry, satellite, IoT).
- `GET /staleness` — staleness from `ORACLE_STALENESS_FILE` (optional JSON input).
- `POST /staleness` — compute staleness from a JSON body:

```json
{
  "projects": [
    {
      "projectId": "VCS-1234",
      "methodology": "VERRA-VCS",
      "createdAt": "2024-01-01T00:00:00Z",
      "lastVerifiedAt": "2025-02-01T00:00:00Z"
    }
  ]
}
```

### API endpoints

```bash
# Provider stats + slash/challenge history straight from the chain
curl http://localhost:3000/oracle/stats/GBUDFMPN4L7SE6Y3S6W7F7Q5L7Y3S6W7F7Q5L7Y3S6W7F7Q5L7Y3S6W7F

# Staleness metric per project and provider
curl http://localhost:3000/oracle/monitoring/staleness
```

## Staleness metric definition

- **Cadence**: expected seconds between verified reports, per methodology
  (`VERRA-VCS` = 365d, `REMOTE-SENSING` = 90d, `IOT-SENSORS` = 30d,
  `BLUE-CARBON` = 90d; override via `ORACLE_CADENCE_SECONDS`).
- **Grace**: additional slack before alerting (`ORACLE_GRACE_SECONDS`, default 30d).
- `expectedNextReportAt = lastVerifiedAt + cadence + grace`.
- A project with no verified report falls back to its `createdAt` as baseline.
- `isStale = now > expectedNextReportAt`.

The API scheduler evaluates this every 6 hours and reconciles a durable
**oracle incident** (see below) for every stale project *and* stale provider.
The staleness snapshot itself remains queryable at
`GET /oracle/monitoring/staleness`; the incident history derived from it is
queryable at `GET /oracle/incidents`.

## Oracle incident lifecycle

Each stale condition (one project, or one provider aggregated across its
projects) is tracked as a durable incident in Postgres, not just a log line
-- log-only alerting gave operators no way to see what was currently
degraded, acknowledge that someone was handling it, or confirm it had
actually been resolved.

**Status**: `active` -> `acknowledged` -> `resolved`. An incident can be
resolved directly from `active` (acknowledgement is optional, not a required
step).

**Deduplication**: a project or provider that is still stale on the next
6-hourly cron cycle updates its existing incident (`occurrenceCount` +1,
`lastDetectedAt` refreshed) instead of creating a new one. This is enforced
at the database level (a partial unique index on the incident's dedupe key,
scoped to non-resolved rows), so it holds even if the scheduler somehow runs
concurrently across multiple API instances.

**Escalation**: `severity` starts at `warning`. Once `occurrenceCount`
reaches a configurable threshold, it escalates to `critical`. Configure via
`ORACLE_INCIDENT_ESCALATION_THRESHOLDS`, a comma-separated `count:severity`
list, e.g. `3:critical` (the default -- three consecutive 6-hourly cycles,
i.e. ~18 hours of continuous staleness). The log line
`Oracle incident escalated to critical: ...` marks the transition.

**Recurrence**: once an incident is resolved, the *next* time the same
project or provider goes stale, a brand-new incident is opened
(`occurrenceCount` restarts at 1) rather than reopening the resolved one --
the resolved incident's history (who resolved it, when, and any note) is
never overwritten.

### Managing incidents via API

All three endpoints require an authenticated admin session
(`JwtAuthGuard` + `AdminGuard`, same as other privileged endpoints like
`POST /bonds/:id/sweep-undistributed`).

```bash
# List active incidents (also accepts status=acknowledged / status=resolved, page, limit)
curl -H "Authorization: Bearer $ADMIN_JWT" \
  "http://localhost:3000/oracle/incidents?status=active"

# Acknowledge an incident (someone is investigating)
curl -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  -H "x-wallet-address: $ADMIN_ADDRESS" \
  http://localhost:3000/oracle/incidents/<incident-id>/acknowledge

# Resolve an incident once the underlying cause is fixed
curl -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  -H "x-wallet-address: $ADMIN_ADDRESS" -H "Content-Type: application/json" \
  -d '{"resolutionNote": "Provider ingest job restarted; fresh report verified"}' \
  http://localhost:3000/oracle/incidents/<incident-id>/resolve
```

Resolving before the underlying staleness clears is safe but temporary: if
the project or provider is still stale on the next cron cycle, a new
incident opens (see Recurrence above) -- resolving is a record of "this was
handled," not a suppression switch.

## Interpreting provider stats

`GET /oracle/stats/:providerAddress` returns (from chain storage):

- `reportsSubmitted` — lifetime reports submitted.
- `challengesFaced` — reports that were challenged.
- `slashes` / `totalPenalty` — rejected challenges that slashed stake (10% each).
- `slashHistory` — per-slash record (`reportId`, `penalty`, `remainingStake`, `activeAfter`).
- `challengeHistory` — per-challenge record with resolution.

A provider accumulating slashes, or dropping to `active: false` (stake
zeroed), has been through the enforcement path and should be reviewed.

## Alert → action matrix

| Alert | Meaning | Action |
|-------|---------|--------|
| `Oracle incident opened: project/provider X is stale` | New incident: no verified report within cadence + grace | Contact provider; verify ingest jobs are running; check adapter health; then acknowledge the incident via `POST /oracle/incidents/:id/acknowledge` |
| `Oracle incident escalated to critical: ...` | Same incident has now recurred past `ORACLE_INCIDENT_ESCALATION_THRESHOLDS` | Treat as a priority page, not routine monitoring -- see `GET /oracle/incidents?status=active` for `occurrenceCount` |
| `Adapter <x> status: down` | Upstream returned 5xx, timeout, or DNS failure | Check upstream provider status / credentials / network |
| `Adapter <x> status: degraded` | 4xx response, or latency above threshold | Check API keys, rate limits, quota |
| `provider slashed` event / `slashes > 0` | A rejected challenge applied the 10% penalty | Investigate report quality; watch stake; consider rotation |

## Recovery flow

1. **Confirm scope.** Is one adapter down or the whole chain RPC?
   `GET /health` isolates upstreams; `GET /oracle/monitoring/staleness` shows
   which projects are affected.
2. **Fix the ingest path.** Check the `oracle` ingest jobs
   (`npm run ingest`, `npm run monitor`), credentials, and upstream quotas.
3. **Re-run ingestion.** Re-publish the missed report via the API
   (`POST /oracle/reports`) so a fresh verified report resets the staleness
   clock.
4. **Escalate within the challenge window.** A report that stays un-verified
   past the 72-hour challenge window cannot be corrected without a new
   submission.
5. **Rotate or de-activate.** For providers that repeatedly fail, use
   `remove_provider` (admin) or let slashing deactivate them at zero stake.
6. **Verify recovery.** `GET /oracle/monitoring/staleness` should flip
   `isStale` to `false` for the affected projects within the next scheduler
   cycle.
7. **Resolve the incident.** `POST /oracle/incidents/:id/resolve` with an
   optional `resolutionNote`, once the cause is fixed. If staleness returns
   later, a fresh incident opens rather than reusing this one (see
   Recurrence above), so resolving does not need to wait for absolute
   certainty that the issue won't recur.
