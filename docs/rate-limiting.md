# Rate Limiting Configuration

This document outlines the API rate limiting design, architecture, and configuration options.

---

## Architecture Overview

The API enforces rate limits on high-impact endpoints (authentication, oracle submission, and transaction mutations) to protect the Stellar node and the API gateway from denial-of-service (DoS) attacks and brute-forcing.

Throttling is implemented globally in NestJS via `RateLimitGuard` and backed by Redis.

```
                  +--------------------+
                  |    HTTP Request    |
                  +---------+----------+
                            |
                            v
                  +---------+----------+
                  |   RateLimitGuard   |  <- Check Redis for IP/Wallet keys
                  +---------+----------+
                            |
              +-------------+-------------+
              |                           |
     [Limit Exceeded]             [Below Limit]
              |                           |
              v                           v
   +----------+----------+     +----------+----------+
   |   HTTP 429 Error    |     |  Forward to Route   |
   |   Retry-After: 45   |     |  Increment count    |
   +---------------------+     +---------------------+
```

---

## Keys and Limits Strategy

Endpoints are grouped into three distinct categories, each with independent limits:

1.  **Authentication (`auth`)**:
    *   **Applied to**: `/auth/challenge`, `/auth/verify`, `/auth/refresh`.
    *   **Keys**: Limit per IP (`ratelimit:auth:ip:<ip>`) and per Wallet address if provided in verify DTO (`ratelimit:auth:wallet:<wallet>`).
    *   **Defaults**: Max **5 requests per 60 seconds**.
2.  **Oracle Providers (`oracle`)**:
    *   **Applied to**: `/oracle/reports` (submit report), `/oracle/challenge/:id`, `/oracle/providers` (register).
    *   **Keys**: Limit per Provider address (`ratelimit:oracle:provider:<address>`) and per IP (`ratelimit:oracle:ip:<ip>`).
    *   **Defaults**: Max **10 requests per 60 seconds**.
3.  **Transaction Mutations (`mutation`)**:
    *   **Applied to**: Bond creation, subscription, maturity, credit claims, token transfers, DEX listing, DEX purchasing, deposits, withdrawals, and order cancellations.
    *   **Keys**: Limit per Wallet address (`ratelimit:mutation:wallet:<address>`) and per IP (`ratelimit:mutation:ip:<ip>`).
    *   **Defaults**: Max **10 requests per 60 seconds**.

---

## Configuration Reference

You can configure rate limits globally and per-category in your `.env` file using the following environment variables:

| Environment Variable | Default Value | Description |
|---|---|---|
| `RATE_LIMIT_DEFAULT_TTL` | `60` | Default sliding window duration (seconds) |
| `RATE_LIMIT_DEFAULT_LIMIT` | `60` | Default maximum requests allowed per window |
| `RATE_LIMIT_AUTH_TTL` | `60` | Authentication window duration (seconds) |
| `RATE_LIMIT_AUTH_LIMIT` | `5` | Authentication maximum requests allowed per window |
| `RATE_LIMIT_MUTATION_TTL` | `60` | Transaction mutation window duration (seconds) |
| `RATE_LIMIT_MUTATION_LIMIT` | `10` | Transaction mutation maximum requests allowed per window |
| `RATE_LIMIT_ORACLE_TTL` | `60` | Oracle provider window duration (seconds) |
| `RATE_LIMIT_ORACLE_LIMIT` | `10` | Oracle provider maximum requests allowed per window |

---

## Resiliency and Fail-Open

To guarantee that a cache failure does not cause an API outage, `RateLimitGuard` utilizes a **fail-open strategy**. If the Redis connection degrades or becomes unhealthy:
1.  The error is logged to warn operators.
2.  `isHealthy()` returns `false`.
3.  `RateLimitGuard` bypasses rate checks and allows requests to proceed directly to the Stellar node.
