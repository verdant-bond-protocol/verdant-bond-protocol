# Admin Step-Up Intent Verification (#115)

High-risk admin actions are protected by a signed "step-up" intent. The caller
must prove a fresh, deliberate, single-use authorisation for the exact action
and target — not just that their wallet is an admin.

## Which endpoints are protected

| Action | Endpoint |
|---|---|
| `issue_bond` | `POST /bonds` |
| `distribute_coupon` | `POST /bonds/:id/coupon` |
| `sweep_undistributed` | `POST /bonds/:id/sweep-undistributed` |
| `mature_bond` | `POST /bonds/:id/mature` |
| `reconcile_holders` | `POST /bonds/:id/reconcile-holders` |
| `reindex_holders` | `POST /bonds/admin/reindex-holders` |
| `approve_project` | `POST /projects/:id/approve` |
| `reject_project` | `POST /projects/:id/reject` |
| `register_provider` | `POST /oracle/providers` |
| `acknowledge_incident` | `POST /oracle/incidents/:id/acknowledge` |
| `resolve_incident` | `POST /oracle/incidents/:id/resolve` |

## Intent payload

The admin signs a canonical message over:

```
action|target|chain|expiry|nonce
```

and sends it (base64 signature) in the `x-admin-intent` header as JSON:

```json
{
  "action": "distribute_coupon",
  "target": "7",
  "chain": "Test SDF Network ; September 2015",
  "expiry": 1710000000000,
  "nonce": "a-uuid",
  "signature": "base64..."
}
```

The `target` must equal the route's id (or `global` for global actions). The
`action` must match the endpoint's required action. `expiry` is Unix
milliseconds; stale intents are rejected.

## Replay protection

Each `nonce` may be used exactly once. Used nonces are stored in Redis
(`admin-intent:<nonce>`) and expire shortly after the intent's `expiry`. A
replayed nonce returns `409 Conflict` deterministically.

## Signing (admin tooling / frontend)

Sign with the admin's Stellar ed25519 secret key:

```ts
import { Keypair } from '@stellar/stellar-sdk';

const kp = Keypair.fromSecret(ADMIN_SECRET);
const message = `${action}|${target}|${chain}|${expiry}|${nonce}`;
const signature = kp.sign(new TextEncoder().encode(message)).toString('base64');
```

`AdminIntentService` in the frontend builds and signs this payload when an
admin signing secret is configured in the admin console. End-user Freighter
wallets do not sign admin intents.

## Failure modes (all return 401 unless noted)

- Missing/incomplete intent → `401`
- Expired intent → `401`
- Wrong action → `401`
- Wrong target → `401`
- Invalid signature → `401`
- Replayed nonce → `409 Conflict`

## Intent receipts

Every intent decision on these endpoints also produces a signed receipt
(`rejected`, `authorized` → `succeeded` / `failed`), returned as the
`x-intent-receipt-id` response header and reviewable under
`/admin/intent-receipts`. Look up the receipt before retrying an action whose
response you did not receive. See
[maintainer-intent-receipts.md](maintainer-intent-receipts.md).
