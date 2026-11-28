# Synthetic Journey Monitor (#380)

The monitor exercises the protocol's most valuable workflow, **investor subscription**
(capital entering a green bond), against a running API. It reports per-step latency,
failures, and the dependency to blame.

Code:

- `api/src/ops/synthetic-journey.monitor.ts`: the journey logic, with no framework
  dependencies.
- `api/scripts/synthetic-journey.ts`: the runner (`npm run monitor:journey`).
- Tests: `api/src/ops/synthetic-journey.monitor.spec.ts`.

## The journey

| # | Step | Request | On a 5xx, blames |
|---|---|---|---|
| 1 | `readiness` | `GET /api/health/ready` | whatever it reports as degraded: `redis`, `soroban-rpc` (contract unreachable), or `config` (misconfigured contract address) |
| 2 | `list-bonds` | `GET /api/bonds?page=1&limit=20`, picks the first `Active` bond with room for `--amount` (or uses `--bond`) | `soroban-rpc` |
| 3 | `bond-detail` | `GET /api/bonds/:id/detail` | `soroban-rpc` |
| 4 | `preview-subscribe` | `GET /api/bonds/:id/preview-subscribe?amount=N`; `expected_failure` must be `null` | `soroban-rpc` |
| 5 | `subscribe` (`--write` only) | `POST /api/bonds/:id/subscribe` with a fresh `Idempotency-Key` | `stellar-network` |
| 6 | `confirm-transaction` (`--write` only) | polls `GET /api/stellar/transactions/:hash` every 5 s, up to 60 s | `stellar-network` |

Attribution rules for every request:

| Outcome | Blamed on |
|---|---|
| No answer or timeout | `api` |
| 401/403 | `config` (the synthetic credentials) |
| Any other 4xx | `api` (a contract regression) |
| No subscribable bond, or the preview predicts a rejection | `data` |

`blame` is the dependency of the **first** failed step. `degradedDependencies` (from step 1)
corroborates it. Readiness is diagnostic: the journey continues past a degraded readiness
result, so the report shows whether users are actually affected. Steps 2 to 6 depend on each
other, so the run stops at the first one that fails.

Blame comes from the HTTP status and the readiness probe, never from the error text. The
API's RFC 7807 filter replaces most messages with a generic `detail`, which the report
copies only as context.

Timings follow the network:

- Ledgers close roughly every 5 seconds, so confirmation polls once per ledger.
- The API builds transactions with a 30-second validity window
  (`TransactionBuilder.setTimeout(30)`, which sets the transaction's `maxTime`), and a
  transaction submitted after its time bounds cannot enter a ledger. 60 seconds is
  therefore twice the time in which it can still land.
- Status comes from Stellar RPC `getTransaction`: `SUCCESS` maps to confirmed, `FAILED` to
  failed, and `NOT_FOUND` to pending. Default RPC retention is 120,960 ledgers, about
  7 days, so a recent hash is always within range.

## Running it

```bash
# one read-only run (safe on any network, mainnet included)
npm run monitor:journey -- --base-url=https://api.example.org
npm run monitor:journey -- --base-url=http://localhost:3000 --bond=3 --amount=1 --json

# scheduled: one JSON line per run every 5 minutes; runs never overlap
npm run monitor:journey -- --base-url=https://api.example.org --interval=300

# full happy path including a real subscription (testnet/staging only)
SYNTHETIC_INVESTOR_TOKEN=<jwt> SYNTHETIC_INVESTOR_ADDRESS=G... \
  npm run monitor:journey -- --base-url=https://api.testnet.example.org --write
```

| Variable | Default | Purpose |
|---|---|---|
| `SYNTHETIC_BASE_URL` | `http://localhost:3000` | API origin when `--base-url` is omitted |
| `SYNTHETIC_STEP_TIMEOUT_MS` | `10000` | Per-request timeout |
| `SYNTHETIC_INVESTOR_TOKEN` / `SYNTHETIC_INVESTOR_ADDRESS` | none | Credentials of a KYC-verified synthetic investor, required by `--write` |
| `STELLAR_NETWORK` | none | `--write` is refused when this is `mainnet` |

Exit codes for a single run:

- `0`: the journey passed.
- `1`: the journey failed (alert on this).
- `2`: misuse, for example `--write` on mainnet or missing credentials.

To schedule it, run a single run from cron or a CI schedule and alert on a non-zero exit, or
run `--interval` as a long-lived process and alert on `"ok":false` lines.

## Sample report

```json
{
  "journey": "investor-subscription",
  "ok": false,
  "totalLatencyMs": 104,
  "bondId": 3,
  "steps": [
    { "name": "readiness", "ok": false, "latencyMs": 89, "attempts": 1, "dependency": "soroban-rpc", "error": "Degraded: soroban-rpc" },
    { "name": "list-bonds", "ok": true, "latencyMs": 10, "attempts": 1 },
    { "name": "bond-detail", "ok": false, "latencyMs": 4, "attempts": 3, "httpStatus": 504, "dependency": "soroban-rpc",
      "error": "GET /api/bonds/3/detail → 504: An unexpected error occurred. Please contact support with your correlation ID." }
  ],
  "blame": "soroban-rpc",
  "degradedDependencies": ["soroban-rpc"]
}
```

## Bounded retries for transient faults

By default each step is attempted once. `--max-attempts=N` (env
`SYNTHETIC_MAX_ATTEMPTS`, default `1`) retries *transient* step faults up to
`N` total attempts, waiting `--retry-delay-ms=M` (env
`SYNTHETIC_RETRY_DELAY_MS`, default `0`) between them. `POST /ops/synthetic-journey`
exposes the same two controls as query parameters.

| Fault | Retried? | Blame |
|---|---|---|
| Timeout, dropped connection, network error | yes | `api` |
| HTTP 408 / 429 / 5xx | yes | the step's own dependency (e.g. `soroban-rpc`) |
| HTTP 401 / 403 | **no** | `config` (synthetic credentials) |
| Other 4xx | **no** | `api` |
| Degraded `/health/ready` | **no** | the degraded dependency |
| No subscribable bond / predicted contract rejection | **no** | `data` |
| Transaction failed or never settled | **no** | `stellar-network` |

Each `steps[]` entry now carries an `attempts` count, so an alert can distinguish
"flaky but recovered" (`attempts > 1, ok: true`) from "down" (`attempts == N,
ok: false`). Retrying a *write* step is safe: one idempotency key is generated per
run and reused by every subscribe attempt, so a lost reply cannot cause a second
subscription.

Tests: `api/src/ops/synthetic-journey.retry.spec.ts` covers normal (no retries),
transient 5xx/408/429/network retries, bounded exhaustion, authorization
(never retried), degraded readiness, idempotency-key reuse and per-run key
generation.

## Edge cases and failure modes

- **Retries extend a run's duration.** `totalLatencyMs` includes retry delays,
  so keep `stepTimeoutMs × maxAttempts + retryDelayMs × (maxAttempts − 1)` below
  the scheduler's interval to avoid overlapping runs. Scheduled runs never
  overlap by design.
- **A retried 5xx is still an incident.** `attempts > 1` on a passing step means
  the dependency was flaky; alert on the count as well as on `ok: false`.
- **Cached reads.** `GET /api/bonds` is cached in Redis for 60 seconds, so `list-bonds` can
  pass while Soroban RPC is down. `bond-detail` and `preview-subscribe` read the chain, so
  they still catch it.
- **The probe bond fills up.** `list-bonds` picks another bond. With `--bond`, the run fails
  with blame `data`. Point `--bond` at a dedicated monitoring bond with ample supply.
- **Write mode spends real test funds and changes holder balances.** Use a dedicated
  synthetic investor and bond on testnet or staging. Each run uses a fresh
  `Idempotency-Key`, so runs never collide, and a retried run cannot replay another run's
  subscription.
- **The synthetic token expires.** `subscribe` fails with blame `config`. Rotate
  `SYNTHETIC_INVESTOR_TOKEN`.
- **The monitor host loses its network.** Every step fails with blame `api`. Run the
  monitor from at least two locations before paging on `api` blame.
- **Read-only runs change nothing.** They only perform GET requests.

## Rollback

The monitor only calls public endpoints and has no state. To roll back, stop the scheduled
runs and remove the `monitor:journey` script. Nothing else depends on it. To disable
retries without touching the runner, remove `--max-attempts` / the
`SYNTHETIC_MAX_ATTEMPTS` env var (the default is one attempt, the original
behaviour). The added `steps[].attempts` field is additive: consumers that ignore
it keep working.
