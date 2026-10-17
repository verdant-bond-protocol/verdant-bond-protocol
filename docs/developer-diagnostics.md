# Contributor Diagnostics

`npm run diagnostics` (from the `api` directory) is the single command a
contributor runs to validate their local setup and the external-service
assumptions the API makes. It is **read-only**: it never migrates, seeds, or
mutates anything.

```bash
cd api
npm run diagnostics
```

Exit code is `0` when every check passes and `1` when any check fails, so it can
be wired into pre-flight scripts or CI.

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

## Design

All pass/fail decisions and remediation strings live in
[`api/src/ops/developer-diagnostics.ts`](../api/src/ops/developer-diagnostics.ts)
as pure functions with no filesystem or network access. The executable
[`api/scripts/diagnostics.ts`](../api/scripts/diagnostics.ts) only gathers the
real facts (versions, files, and connectivity probes) and feeds them in. This
keeps the contract testable:

- `api/src/ops/developer-diagnostics.spec.ts` — version checks, dotenv parsing,
  required-variable detection, connectivity shaping, and report formatting.

## Operational edge cases

- **No network**: Redis/Postgres checks fail fast (2s timeout) rather than
  hanging; the remediation points at `docker compose up`.
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
