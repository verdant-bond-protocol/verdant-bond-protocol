# Contributor Diagnostics

`./scripts/diagnostic.sh` is the single root command a contributor runs to
validate their local setup and the external-service assumptions the API makes.
It is **read-only**: it never migrates, seeds, or mutates anything. The wrapper
can be run from any current directory and delegates to the tested API command.

```bash
./scripts/diagnostic.sh
```

Exit code is `0` when every check passes and `1` when any check fails, so it can
be wired into pre-flight scripts or CI.

| Flag | Effect |
| --- | --- |
| `--json` | Print the summary as JSON (`results`, `failures`, `passed`; failing connectivity rows carry a `category`). |
| `--no-retry` | Probe Redis/Postgres once instead of retrying transient failures. |

```bash
./scripts/diagnostic.sh --json --no-retry
```

## What it checks

| Check | Passing condition | Remediation on failure |
| --- | --- | --- |
| Node.js runtime | major ≥ 18 (CI uses 20) | Install Node.js v18+ |
| Node dependencies | `api/node_modules` exists | `npm ci` (or `npm install`) |
| Environment file | `api/.env` exists | Copy `.env.example` to `.env` |
| Required variables | `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` set | Add the missing key to `api/.env` |
| Seed tooling | `api/scripts/seed.ts` present | Restore the seed script |
| Redis connectivity | `PING` succeeds within 2s | Start Redis or fix `REDIS_URL` |
| PostgreSQL connectivity | `SELECT 1` succeeds within 2s | Start Postgres or fix `DATABASE_URL` |

Values in `api/.env` are loaded only for keys that are not already present in the
process environment, so exported variables always win.

## Setup failure classification (#513)

A failing connectivity probe is not just reported as "unreachable": the raw
error is classified by
[`api/src/ops/setup-failure-diagnostics.ts`](../api/src/ops/setup-failure-diagnostics.ts)
so the remediation targets the actual cause.

| Category | Typical trigger | Retried? | Remediation |
| --- | --- | --- | --- |
| `connection-refused` | `ECONNREFUSED` — service not started | yes | `docker compose up -d <service>` or fix host/port |
| `timeout` | `ETIMEDOUT`, connect timeout, Postgres `57P03` "starting up" | yes | wait for the container, check `docker compose ps`/VPN |
| `dns` | `EAI_AGAIN` (transient) / `ENOTFOUND` (wrong host) | only `EAI_AGAIN` | use `localhost`, not the compose service name, from your machine |
| `authentication` | Postgres `28P01`/`28000`, Redis `NOAUTH`/`WRONGPASS` | **no** | fix user/password in the URL to match `docker-compose.yml` |
| `authorization` | Postgres `42501`, Redis `NOPERM` | **no** | grant DB ownership / Redis ACL, or use the compose superuser |
| `missing-database` | Postgres `3D000` | no | `createdb verdant` or recreate the compose volume |
| `missing-dependency` | `MODULE_NOT_FOUND` | no | `npm ci` |
| `port-in-use` | `EADDRINUSE` | no | free the port or remap it |
| `unknown` | anything else | no | check `docker compose logs <service>` |

### Retry behaviour

Retryable categories are probed up to 3 times with doubling backoff
(500ms, 1s), so a container that is still booting does not produce a false
failure. Credential and privilege failures are **never** retried: retrying a
bad password only burns time and can trip lockout policies. The final row
says how many attempts were made (`… after 3 attempts`).

### Credential safety

Connection strings are printed with the password replaced by `***`, and any
`scheme://user:password@` sequence inside a raw driver error is masked before
it is shown. A string that cannot be parsed as a URL is not echoed at all.

## Design

All pass/fail decisions and remediation strings live in
[`api/src/ops/developer-diagnostics.ts`](../api/src/ops/developer-diagnostics.ts)
as pure functions with no filesystem or network access. The executable
[`api/scripts/diagnostics.ts`](../api/scripts/diagnostics.ts) only gathers the
real facts (versions, files, and connectivity probes) and feeds them in. This
keeps the contract testable:

- `api/src/ops/developer-diagnostics.spec.ts` — version checks, dotenv parsing,
  required-variable detection, connectivity shaping, and report formatting.
- `api/src/ops/setup-failure-diagnostics.spec.ts` — error classification
  (including auth/authorization), retry/backoff and give-up, credential
  redaction, and report-row shaping.

### Compatibility

`DiagnosticResult`, `buildSummary`, `formatSummary`, `checkConnectivity`, and
the exit-code contract are unchanged. Failing connectivity rows gain an
optional `category` field; text output keeps the same `[PASS]/[FAIL]` shape.

## Operational edge cases

- **No network**: Redis/Postgres checks fail fast (2s timeout per attempt, at
  most ~7.5s with retries) rather than hanging; use `--no-retry` for a single
  probe.
- **Service still starting**: refused/timeout/"starting up" errors are retried
  with backoff before being reported.
- **Wrong credentials**: reported once as `authentication` with no retry; the
  password is never printed.
- **Missing `.env.example`**: the template check is skipped, but the `.env`
  check still reports the exact remediation.
- **Partial `.env`**: each required variable is reported independently so the
  contributor fixes exactly what is missing.

## Rollback / recovery

The command is read-only and has no side effects, so there is nothing to roll
back. If a check becomes wrong, fix the pure logic in
`developer-diagnostics.ts`; the spec freezes the expected remediation messages.

## Common failure fixes

| Symptom | Fix |
| --- | --- |
| `[FAIL] Node.js runtime` | Upgrade Node.js (nvm: `nvm install 20`). |
| `[FAIL] Node dependencies installed` | `npm ci` in `api`. |
| `[FAIL] Environment file (.env)` | `cp api/.env.example api/.env`. |
| `[FAIL] Redis connectivity` | `docker compose up -d redis` |
| `[FAIL] PostgreSQL connectivity` | `docker compose up -d postgres` |
| `… authentication: … rejected the credentials` | Fix user/password in `DATABASE_URL` / `REDIS_URL`. |
| `… missing-database: …` | `createdb verdant` |
| `… dns: … does not resolve` | Use `localhost` instead of the compose service name. |
