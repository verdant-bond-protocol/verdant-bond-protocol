# Dependency-aware health endpoint

Issue: [#409](https://github.com/verdant-bond-protocol/verdant-bond-protocol/issues/409)

The public, unauthenticated health surface at `/health` reports the liveness of
the API **and** the state of its hard dependencies, so an orchestrator,
load-balancer, or status page can tell "the process is up" apart from "the
process is up but cannot serve traffic".

## Endpoints

| Method | Path                   | Auth | Purpose                                             |
| ------ | ---------------------- | ---- | --------------------------------------------------- |
| `GET`  | `/health`              | none | Full report: overall status + every dependency.     |
| `GET`  | `/health/dependencies` | none | Same dependency list, trimmed of uptime details.    |

Pre-existing probes remain available and are unrelated to this endpoint:

- `GET /health/redis` – cache-only readiness.
- `GET /health/ready` – contract-address reachability.

## Response shape

```json
{
  "status": "healthy",
  "timestamp": "2026-10-17T00:00:00.000Z",
  "uptimeMs": 123456,
  "dependencies": [
    {
      "name": "redis",
      "state": "operational",
      "message": "Redis is healthy",
      "latencyMs": 0,
      "lastCheckedAt": "2026-10-17T00:00:00.000Z",
      "critical": true
    }
  ]
}
```

`state` is one of `operational`, `degraded`, `down`, `unknown`. Each dependency
is marked `critical` or not.

## Overall status derivation

- **`down`** — at least one **critical** dependency is `down`. HTTP status `503`.
- **`degraded`** — no critical failure, but some dependency is not
  `operational`. HTTP status `200`.
- **`healthy`** — every dependency is `operational`. HTTP status `200`.

The report **never throws** for a failing dependency: an indicator that throws
is caught and surfaced as `down`, so the health endpoint itself cannot be taken
down by the very outage it is meant to report.

## Failure and edge-case behaviour

- An indicator that times out or throws is reported as `down` with the error
  message; the remaining indicators are still evaluated (checks run
  concurrently via `Promise.allSettled`).
- A non-critical dependency failing degrades the service but does not flip the
  HTTP status to `503`, so an optional dependency cannot pull the instance out
  of a load-balancer rotation.
- Adding a new dependency is a one-line `registerIndicator(indicator, critical)`
  call; no endpoint changes are required.

## Testing

`api/src/health/health.service.spec.ts` covers the normal, degraded, down,
throwing-indicator, and registration paths.
