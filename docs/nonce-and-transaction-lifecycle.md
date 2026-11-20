# Nonce and Transaction Lifecycle

State-changing API calls use a nonce scoped by `(contractAddress, address)`.

1. `NonceService` acquires a Redis lock for the scope.
2. The cached cursor and contract `get_nonce(address)` view are compared. Contract state is authoritative and repairs stale cursors.
3. The nonce is reserved for the complete simulation, preparation, submission, and Soroban polling lifecycle.
4. The Redis cursor advances only after `getTransaction()` returns `SUCCESS`.
5. Simulation, submission, polling, timeout, or contract failures resynchronize the cursor from `get_nonce` before releasing the lock.

The lock prevents duplicate nonces for the same scope across concurrent API instances. Different contracts and addresses can proceed independently.

## Operations

The defaults are a 300-second lock TTL, a 180-second lock wait, a 1-second Soroban polling interval, and a 120-second transaction timeout. They can be changed with `NONCE_LOCK_TTL_MS`, `NONCE_LOCK_WAIT_MS`, `NONCE_LOCK_RETRY_MS`, `SOROBAN_POLL_INTERVAL_MS`, and `SOROBAN_POLL_TIMEOUT_MS`.

If a process is terminated while a transaction is pending, wait for the lock TTL or inspect the transaction hash in Soroban RPC. The next request automatically reads contract state and repairs the Redis cursor. Manual repair should only be needed if the contract `get_nonce` view is unavailable; in that case remove the affected `nonce:<contract>:<address>` key after confirming the on-chain nonce, then retry once RPC is healthy.

Marketplace order and price caches are indexed by the `orders` and `prices` tags. Marketplace mutations invalidate those tags, including order detail, order list, and derived price-feed entries.

## Project Roles

Project registration requires a valid JWT. The project owner is always `req.user.walletAddress`; clients cannot provide or override the owner in the request body. Approval and rejection require both a valid JWT and the configured admin wallet enforced by `AdminGuard`. Public project reads remain unauthenticated.
