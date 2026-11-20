# Duplicate Suppression for Notifications and Webhooks (#410)

Delivery is at-least-once on both sides:

- **Notifications:** producers such as recovery and partial-failure handling re-emit an
  event when they retry.
- **Webhooks:** senders redeliver until they see a `2xx`. Stripe, for example, retries
  for up to three days, each time with the same event id but a new timestamp and
  signature.

Duplicates must be absorbed without being processed twice.

## Webhooks (`WebhookVerificationService`)

Checks run in this order: timestamp window → signature → duplicate. Authenticity is
established before duplicate status, so only a genuinely signed redelivery is ever
acknowledged as a duplicate.

| Delivery | Response | Handler runs? |
|---|---|---|
| First authentic delivery | Handler's response | Yes |
| Authentic redelivery of a processed event | `200 { received: true, duplicate: true }` | No |
| Redelivery while the first is still running | `409` (retry later) | No |
| Redelivery after the first returned `5xx` or the connection dropped | Processed normally | Yes |
| Processed id with a bad signature or altered payload | `401` | No |
| Timestamp outside the replay window | `401` | No |

- **Why a duplicate gets `200`, not `401` as before:** a non-`2xx` response makes the
  sender keep retrying a delivery that was already handled. The response proves nothing new
  to an attacker, who already holds the signed message, and nothing is re-processed.
- **Retention:** a processed id is remembered for the longer of its replay window and
  `dedupeWindowMs`. That is a new, optional config field, defaulting to 72 hours. Set it to
  at least the sender's retry horizon.
- **Memory bound:** remembered ids are capped at 100,000 and expired ids are evicted from
  the front. Each event costs amortised O(1) time; memory is O(remembered ids).

`verifyWebhook()` keeps its contract: a duplicate is still `valid: false` with
`error: 'Event already processed'`, and now also carries `duplicate: true`. The new
`releaseEvent(id)` lets a non-middleware caller forget an event whose processing failed.

## Notifications (`NotificationsService`)

- **Final decision:** every `(user, eventId)` decision, delivered or suppressed by
  preference, goes into an O(1) index, and that decision is final. A redelivered event
  never produces a second decision or a second inbox entry, even if the user changed
  preferences in between. Before, only delivered notifications were deduplicated, using an
  O(n) scan.
- **Scope:** suppression is per recipient. The same `eventId` still reaches a different
  user. Mandatory alerts are de-duplicated as well, and their first delivery is never
  suppressed.
- **Across restarts:** with `DATABASE_URL` set, decisions from the last 30 days are
  restored from `notification_decisions` at startup, so a producer retry after a restart is
  still suppressed. The table's existing `UNIQUE (user_id, event_id)` already prevents
  duplicate rows.

## Failure modes and recovery

| Situation | Behaviour | Recovery |
|---|---|---|
| Webhook handler fails (`5xx`) or the client disconnects | The id is released, and the sender's retry is processed | None needed |
| Webhook handler is slow; the sender retries meanwhile | `409` until the first delivery finishes | The sender retries; it then gets `200` duplicate or reprocesses if the first failed |
| API restarts | Webhook ids are in memory, so a redelivery after a restart is processed again | Make handlers idempotent on the event id (Stripe's guidance is to log processed event ids and skip any already logged), or run a single long-lived instance |
| Several API instances | Each remembers only its own ids | Route each sender to one instance, or move the id store to shared storage (out of scope) |
| `notification_decisions` write fails | Still suppressed in-process; the error is logged | A retry after a restart is not suppressed for that event; re-insert the decision row from the logs if needed |
| Event older than the 30-day restore window | Delivered again after a restart | Widen `DEDUPE_RESTORE_WINDOW_DAYS` if producers retry that late |

**Rollback:** reverting both service changes restores the previous behaviour. No data
migration is involved, because no schema changed.
