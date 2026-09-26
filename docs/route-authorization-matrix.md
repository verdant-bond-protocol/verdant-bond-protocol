# API Route Authorization Matrix

This document is the human-readable counterpart of
`api/src/test/route-authorization.matrix.ts`, which is enforced at test time by
`api/src/test/route-authorization.matrix.spec.ts`. That spec fails the build if a
controller route is added without an entry here, or if the guards wired on a
controller diverge from what is declared below. **Keep the two in sync.**

## Role taxonomy

| Role | Meaning |
| --- | --- |
| `public` | No authentication required (read or write). |
| `wallet-header` | Caller identity is taken from the `x-wallet-address` (or `x-provider-address`) request header only. There is **no** JWT/KYC enforcement at the API boundary. Trust in the header value is the marketplace's accepted model. |
| `authenticated` | A valid JWT session is required (`JwtAuthGuard`). |
| `admin` | A valid JWT session **and** the configured admin key (`JwtAuthGuard` + `AdminGuard`). |

> **Gap note:** No controller route currently requires `KycGuard` (verified-KYC)
> or `ProviderGuard` (provider allow-list) directly. Both guards are unit-tested
> in `api/src/test/guard-roles.spec.ts` and will be reflected in this matrix the
> moment they are attached to a route. The marketplace oracle write paths
> (`oracle/reports`, `oracle/challenge/:reportId`) rely on the `x-provider-address`
> / `x-wallet-address` headers instead of `ProviderGuard`.

## Auth (`/auth`)

| Method | Path | Role | Guards |
| --- | --- | --- | --- |
| POST | `/auth/challenge` | public | — |
| POST | `/auth/verify` | public | — |
| POST | `/auth/refresh` | public | — |
| GET | `/auth/profile` | authenticated | `JwtAuthGuard` |
| GET | `/auth/kyc/:address` | authenticated | `JwtAuthGuard` |
| POST | `/auth/kyc/:address` | authenticated | `JwtAuthGuard` |

## Bonds (`/bonds`)

| Method | Path | Role | Guards |
| --- | --- | --- | --- |
| POST | `/bonds` | public | — |
| GET | `/bonds` | public | — |
| GET | `/bonds/held/:address` | public | — |
| GET | `/bonds/:id` | public | — |
| GET | `/bonds/:id/detail` | public | — | (issue #4: atomically refreshes summary, holders, coupon, and maturity) |
| POST | `/bonds/:id/subscribe` | public | — |
| GET | `/bonds/:id/holders` | public | — |
| POST | `/bonds/:id/coupon` | public | — |
| POST | `/bonds/:id/claim` | public | — |
| GET | `/bonds/:id/undistributed` | public | — |
| POST | `/bonds/:id/sweep-undistributed` | **admin** | `JwtAuthGuard`, `AdminGuard` |
| POST | `/bonds/:id/transfer` | public | — |
| POST | `/bonds/:id/mature` | public | — |
| GET | `/bonds/:id/export` | authenticated | `JwtAuthGuard` |

## Oracle (`/oracle`)

| Method | Path | Role | Guards |
| --- | --- | --- | --- |
| POST | `/oracle/reports` | wallet-header | — |
| GET | `/oracle/reports/:projectId` | public | — |
| GET | `/oracle/reports/:projectId/challenges` | public | — | (issue #3: challenged reports for a project) |
| GET | `/oracle/challenges/:reportId` | public | — | (issue #3: full challenge state + history) |
| GET | `/oracle/projects/:projectId/coupon-eligibility` | public | — | (issue #3: coupon distribution eligibility) |
| POST | `/oracle/challenge/:reportId` | wallet-header | — |
| POST | `/oracle/providers` | public | — |
| GET | `/oracle/providers` | public | — |
| GET | `/oracle/stats/:providerAddress` | public | — |
| GET | `/oracle/monitoring/staleness` | public | — |
| GET | `/oracle/incidents` | **admin** | `JwtAuthGuard`, `AdminGuard` |
| POST | `/oracle/incidents/:id/acknowledge` | **admin** | `JwtAuthGuard`, `AdminGuard` |
| POST | `/oracle/incidents/:id/resolve` | **admin** | `JwtAuthGuard`, `AdminGuard` |

## Projects (`/projects`)

| Method | Path | Role | Guards |
| --- | --- | --- | --- |
| POST | `/projects` | public | — |
| GET | `/projects` | public | — |
| GET | `/projects/:id` | public | — |
| POST | `/projects/:id/approve` | public | — |
| POST | `/projects/:id/reject` | public | — |
| POST | `/projects/:id/documents` | public | — |
| GET | `/projects/:id/export` | authenticated | `JwtAuthGuard` |

## Marketplace (`/marketplace`)

All marketplace mutations authenticate the caller via the `x-wallet-address`
header (`wallet-header`). No JWT/KYC guard is applied at the API boundary.

| Method | Path | Role | Guards |
| --- | --- | --- | --- |
| GET | `/marketplace/quote-assets` | public | — |
| GET | `/marketplace/orders` | public | — |
| POST | `/marketplace/list` | wallet-header | — |
| POST | `/marketplace/buy` | wallet-header | — |
| GET | `/marketplace/quote-balance` | wallet-header | — |
| GET | `/marketplace/wallet-balance` | wallet-header | — |
| POST | `/marketplace/deposit` | wallet-header | — |
| POST | `/marketplace/withdraw` | wallet-header | — |
| DELETE | `/marketplace/orders/:id` | wallet-header | — |
| GET | `/marketplace/orders/:id` | public | — |
| GET | `/marketplace/prices` | public | — |
| GET | `/marketplace/prices/:bondId/best` | public | — |
| GET | `/marketplace/prices/:bondId/slippage` | public | — |
| POST | `/marketplace/reconciliation/run` | wallet-header | — | (issue #2: run quote/order reconciliation) |
| GET | `/marketplace/reconciliation/mismatches` | wallet-header | — | (issue #2: list detected mismatches) |
| POST | `/marketplace/reconciliation/repair` | wallet-header | — | (issue #2: repair a mismatch) |

## Valuations (`/valuations`)

| Method | Path | Role | Guards |
| --- | --- | --- | --- |
| GET | `/valuations` | public | — | (issue #204: credit valuations with staleness metadata) |

## How the tests protect this contract

- `route-authorization.matrix.spec.ts` walks every controller at runtime, reads
  the real `@UseGuards` metadata, and asserts (a) every handler is present in the
  matrix, (b) the HTTP verb and path match, and (c) the guard set matches. Remove
  a guard from a sensitive controller and the build fails.
- `<controller>.controller.guard.spec.ts` files exercise the role matrix
  behaviourally: anonymous callers get `401` before the service is invoked, and
  admin/authenticated callers reach the service. The real guards are swapped for
  header-driven fakes so tests run without a database or passport.
- `guard-roles.spec.ts` unit-tests the guard classes themselves (including the
  not-yet-wired `KycGuard` and `ProviderGuard`).
