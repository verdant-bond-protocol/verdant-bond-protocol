# Optimistic transaction updates (#209)

Soroban transactions take seconds to confirm. The frontend shows the result of
a subscribe or claim immediately, marked **pending confirmation**, and
reconciles it with the chain once the transaction settles. Code:
`frontend/src/app/shared/services/pending-transactions.service.ts`.

## Lifecycle

```
register(hash, operation, effect)   ── persisted to localStorage first
        │
        ▼
   awaiting ──(60 s unconfirmed)──▶ delayed ── user is told it is slow
        │                              │
        ├── confirmed ─ read chain ─┬─ value == expected ─▶ matched     (silent)
        │                           └─ value != expected ─▶ diverged    (notice)
        ├── failed ───────────────────────────────────────▶ rolled_back (alert)
        └── still not found after 5 min ──────────────────▶ rolled_back (alert, "expired")
```

- **Persistence.** The optimistic effect (`kind`, `bondId`, `address`,
  `expected`) is stored with its transaction hash before any view renders it —
  views read optimistic values from the service, not from local component
  state. After a reload the service resumes polling pending transactions and
  re-runs reconciliation for confirmed ones that were not yet checked.
- **Expected values** come from contract semantics: `subscribe` adds the
  amount to the holder balance (`bond-issuer`), `claim_credits` resets the
  holder's claimable credits to zero (`coupon-engine`).
- **Divergence.** Another transaction can land first (e.g. a transfer), so the
  confirmed value may differ from the prediction. The on-chain value is shown,
  and a notice states both numbers.
- **Rollback is never silent.** A failed transaction shows an alert
  (`role="alert"`) explaining that it was not applied, and the on-chain values
  are shown again.
- **Stuck transactions.** The API gives every transaction a 30-second validity
  window (`TransactionBuilder.setTimeout(30)`); after it the network rejects the
  transaction. Past one minute the user is told the confirmation is slow. Past
  five minutes a transaction that Stellar RPC still cannot find (its
  `getTransaction` history covers about 7 days) was not applied, and it is
  rolled back with an "expired" explanation.
- **A failed status request is not a failed transaction.** Polling errors keep
  the transaction pending; only the chain's answer or the expiry rule ends it.

The UI never shows a permanently wrong value: the optimistic value is only
displayed while its transaction is pending, and every settled transaction
triggers a reload of on-chain state.
