# End-to-End Coupon Cycle Test Design

Status: design. This describes the orchestrated environment and the scripted scenario for exercising one full coupon cycle across all four layers (oracle service, contracts, API, frontend), what already exists that it builds on, and the integration-boundary defects found while mapping the layers against each other.

## What exists today

| Asset | Layer | What it covers |
| --- | --- | --- |
| `contracts/tests/src/lib.rs` `integration::*` | contracts | Every cross-contract path in one Soroban test `Env`: registry to issuer to oracle to coupon engine to retirement, DEX settlement, governance rotation. Deterministic, milliseconds, no network |
| `api/test/lifecycle.e2e-spec.ts` | API plus contracts | Drives the deployed contracts on Stellar testnet through the NestJS API: project, bond, report, coupon, marketplace. 400-second budget, needs funded keys from `scripts/setup-e2e-env.ts` |
| `scripts/run-lifecycle-test.sh` | orchestration | Builds contracts, funds keys via Friendbot, runs `deploy-testnet.sh`, then the Jest lifecycle test |
| `scripts/e2e-test.sh` | build smoke | Builds and unit-tests every layer; exercises no cross-layer path |
| `docker-compose.yml` | infra | `postgres`, `redis`, `ipfs`, `api`. No Stellar network, no oracle service, no frontend |
| `oracle/` | oracle service | `ingest:*` runners for Verra, satellite, IoT and blue-carbon feeds, plus `monitor`. Unit-tested with Jest, not driven end to end |
| `frontend/` | frontend | Angular app, `ng test` with ChromeHeadless in CI. No browser-level flow test |

The gap: the only test that crosses the API boundary depends on public testnet (Friendbot rate limits, ledger timing, other users' traffic), and nothing at all drives the oracle service or the frontend as part of a cycle.

## Target environment

Extend `docker-compose.yml` with a `test` profile so `docker compose --profile test up` gives a self-contained network:

| Service | Image or build | Role |
| --- | --- | --- |
| `stellar` | `stellar/quickstart` with `--local --enable rpc` | Local Stellar network with Soroban RPC and Friendbot. Ledgers close on a fixed cadence, no external traffic |
| `postgres`, `redis`, `ipfs` | existing | Unchanged |
| `deployer` | one-shot container from `contracts/` | Runs `stellar contract build`, deploys all seven contracts with `scripts/deploy-testnet.sh` pointed at the local RPC, hands the admin of each operational contract to `Governance`, writes the addresses to a shared volume as `.env.e2e` |
| `oracle` | build from `oracle/` | Runs `ingest:satellite` against a fixture directory mounted read-only instead of the live feed, so the report it submits is known in advance |
| `api` | existing build | Reads `.env.e2e` for contract addresses and the local RPC |
| `frontend` | build from `frontend/` | Served by the production build behind nginx, pointed at `api` |
| `runner` | node image with Playwright | Executes the scenario below against `api` and `frontend` |

Every container waits on health checks (`stellar` RPC `getHealth`, `api` `/health`, `frontend` HTTP 200) before the next starts, so ordering follows readiness, with no fixed sleeps.

## Scenario: one coupon cycle

All numbers are chosen so every layer's expected value can be computed by hand and asserted exactly.

1. Deployer: registry, issuer, oracle consumer, coupon engine, retirement, router and governance are deployed; admin roles are rotated to governance; the deployer records the addresses.
2. Runner via API: a project owner registers project P (methodology `verra_vcs`); a governance proposal approves it; the runner advances the local network past the timelock by waiting for ledgers, not wall-clock sleeps, and executes.
3. Runner via API: admin issues bond B with `total_supply` 10 000, `credit_type` Carbon; investors I1 and I2 subscribe 3 000 and 6 000. 1 000 tokens stay unsubscribed on purpose.
4. Oracle service: `ingest:satellite` reads the fixture for P (100 000 tonnes over the period), signs, and calls `submit_report`. A second fixture-driven verifier account calls `verify_report`; the admin path is not used, so the two-signature threshold is exercised as in production.
5. Runner via API: `POST /bonds/B/coupon` distributes period 0 to the holder list the API reconciles from chain events.
6. Assertions at each layer, in this order:
   - Contracts: `accrued_credits(B, I1) == 33 333 333`, `accrued_credits(B, I2) == 66 666 666`, `get_undistributed_total(B) == 1` (see `coupon-math-invariants.md`, finding 1).
   - API: `GET /bonds/B/claimable-credits` for I1 and I2 returns the same figures in minor units; `GET /bonds/B/detail` shows one period with `report_id` equal to the oracle's report.
   - Frontend (Playwright): the bond detail page for B shows the period, the two holder payouts, and the report link; the investor dashboard for I1 shows a claimable balance of 33.333333 credits.
7. Runner via API: I1 retires 10 credits through `POST /bonds/B/retire`; the frontend shows 23.333333 claimable and one certificate; contracts confirm `accrued_credits(B, I1) == 23 333 333` and `claim_credits` for I1 returns exactly that.
8. Teardown: containers are removed with volumes, so every run starts from ledger 1.

## Determinism

- Time: the local quickstart network closes ledgers every second and no other party submits transactions. Timelocks are crossed by polling `getLatestLedger` until the sequence passes the target, never by `sleep`.
- Data: the oracle reads a fixture; keys are generated once per run and funded from the local Friendbot, which has no rate limit.
- Retries: the runner retries only RPC reads while a transaction is pending, bounded by ledger count, and fails the test on the first unexpected error.
- Isolation: the compose project name includes the CI run id so parallel jobs cannot share a network.
- Budget: the whole scenario is expected in under three minutes; the CI job fails at five.

## CI wiring

A new `e2e` job in `.github/workflows/ci.yml`, after `contracts`, `api`, `oracle` and `frontend`, running `docker compose --profile test up --abort-on-container-exit --exit-code-from runner`. It publishes the runner's Playwright trace and the API logs as artifacts on failure. The testnet-based `run-lifecycle-test.sh` stays as a manual pre-release check.

## Integration-boundary defects found while mapping the layers

These were found by reading each layer's contract with its neighbours, which is the work the scenario above automates. Unit tests in the individual layers could not have caught them.

1. `scripts/run-lifecycle-test.sh` builds contracts with `cargo build --target wasm32-unknown-unknown --release`. `soroban-sdk` 26 refuses that target on Rust 1.82 and later, so the script fails at step 2 on a current toolchain. `stellar contract build` (or `soroban contract build` with the CLI the deploy workflow installs) selects the supported `wasm32v1-none` target. `scripts/e2e-test.sh` has the same problem in a different form: it runs `cargo build --release`, which is a native build, so its "wasm files" count reports whatever a previous build left in `target/`.
2. `api/src/oracle/oracle.service.ts` `getSlashPreview` calls `preview_slash` with `[provider, report_id]`. Until this change the contract had no such entry point at all; `preview_slash` was a free function outside the `#[contractimpl]` block, so the API's call could never have succeeded. The method now exists with the argument order the API uses. The API decodes the result with `data[0]`, `data[1]`, ..., but `SlashPreview` is a struct, and `scValToNative` returns a keyed object for a struct, so those reads are `undefined`. The neighbouring decoders in the same file (`toRecord` and `field`) handle both shapes; `getSlashPreview` should use them. No API unit test covers this method, which is why it survived.
3. The coupon engine could not be built to wasm because it linked the oracle-consumer contract crate as a runtime dependency (duplicate `__constructor` export at link time). Every contract-layer test passed because native test builds do not link a cdylib. Fixed by moving the shared `Report` type into `nbbs-shared`; see `access-control-review.md` F8.
4. `retire_credits` and `claim_credits` kept separate ledgers over the same accrued balance, so an investor who retired through the API and then claimed through it would have been paid twice. Each layer's own tests passed because each observed only its own ledger. Fixed in the contracts; see `coupon-math-invariants.md` finding 2. Step 7 of the scenario is the cross-layer regression for it.

## Out of scope for the first iteration

Multi-period cycles, `Basket` and `Biodiversity` bonds through the frontend, marketplace settlement inside the same run, and mainnet-like fee estimation. Each is a further scenario on the same environment.
