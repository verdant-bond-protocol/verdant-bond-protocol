# Runbook: Holder Index Reindexing (#117)

Bond holder membership is now tracked in a **durable, Redis-independent
index** (`HolderIndexService`) rather than Redis alone. Redis is only a read
cache on top of the index. This runbook covers how to repair and reindex that
index.

## Where holder state lives

- **Source of truth:** the durable holder store, persisted to
  `HOLDER_INDEX_PATH` (default `.data/holder-index.json`). When
  `HOLDER_INDEX_STORE=memory` (the default under `NODE_ENV=test`) it is
  in-memory only.
- **Cache:** Redis key `bond:{id}:holders` is a cache and is **not**
  authoritative. Losing Redis no longer loses holder data.

## When to reindex

- Redis was unavailable, evicted, or rebuilt.
- A transfer happened **outside the API** (e.g. a direct contract call,
  wallet-to-wallet move) and is not reflected in the holder list.
- Coupon distribution is refused with `409` "holder index is stale" or
  "holder index is empty and has never been seeded".

## How to reindex

### Via the API (admin)

```bash
# Reindex a single bond
curl -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  http://localhost:3000/bonds/3/reconcile-holders

# Reindex every known bond
curl -X POST -H "Authorization: Bearer $ADMIN_JWT" \
  http://localhost:3000/bonds/admin/reindex-holders
```

### Via the CLI

```bash
npm run reindex-holders                 # reindex every known bond
npm run reindex-holders -- --bond 3     # reindex a single bond
```

The reconciliation scans every address the index has ever seen (plus any
explicitly supplied counterparties) and queries the on-chain
`get_holder_balance`. Addresses with a positive balance become holders;
zero-balance addresses are pruned.

## Strict mode

`HOLDER_INDEX_STRICT` (default `true`) makes coupon distribution refuse to
run against a stale or empty index. Reconciliation is attempted automatically
before distribution; if it fails or the index has never been seeded, the
request returns `409 Conflict` instead of silently missing holders.

`HOLDER_INDEX_MAX_STALENESS_MS` (default `3600000`, 1 hour) controls how old
the index may be before distribution forces a reconciliation.

## Verifying

After reindexing, compare the API holder list with on-chain balances:

```bash
curl http://localhost:3000/bonds/3/holders
```

Each returned holder should have a positive on-chain balance. If a known
out-of-band transfer is still missing, pass the counterparty address via a
custom reconciliation (extend `reconcileBond(bondId, [extraCandidates])`).
