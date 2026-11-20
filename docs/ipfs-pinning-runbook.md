# IPFS Pinning Runbook — redundant storage & escalation (issues #211, #213)

Project performance reports and third-party certifications are content-addressed
(IPFS CIDv0 / SHA-256, see `ipfs/evidence.ts`) and must stay retrievable for the
bond's full multi-year lifetime. Content-addressing proves integrity, **not**
availability — hence redundant pinning plus active verification.

## Redundant pinning

- Every performance report / certification is pinned via
  `IpfsService.pinRedundant()` to **at least two independent providers**:
  `primary` (`IPFS_API_URL`, Pinata by default) and `secondary`
  (`IPFS_SECONDARY_API_URL`, e.g. a second Pinata region/account or web3.storage).
- `pinRedundant` succeeds if **any** provider accepts; per-provider outcomes are
  returned and partial failures are logged. It throws only when **all**
  providers fail.
- Required env: `IPFS_API_KEY`, `IPFS_SECRET_KEY`, `IPFS_SECONDARY_API_URL`,
  `IPFS_SECONDARY_API_KEY`, `IPFS_SECONDARY_SECRET_KEY`.
  Optional: `IPFS_GATEWAY`, `IPFS_SECONDARY_GATEWAY`, `IPFS_HEALTH_CRON`.

## Automated verification

- `IpfsHealthService` (hourly `@Cron`, override with `IPFS_HEALTH_CRON`) re-fetches
  every tracked hash from **each provider gateway** and checks:
  1. retrievable (HTTP 2xx), 2. bytes hash-match the recorded SHA-256 digest
     when one was stored at track time.
- Track a hash after upload: `ipfsHealth.track(hash, sha256Hex)`.
- `verifyPin` never throws; results are `{ provider, retrievable, hashMatches }[]`.

## Escalation / re-pinning procedure

1. **Automatic**: `verifyOne` attempts `pin(hash)` (primary API) for any failing
   provider and logs a warning.
2. **Operator**: if the re-pin also fails an `IPFS ESCALATION` error is logged
   with the hash + provider. Operator then:
   - `curl <secondary-gateway>/<hash>` to confirm the surviving copy;
   - re-pin manually (`POST <api>/pinning/pinByHash`) or rotate provider
     credentials and re-run verification;
   - if the document itself is lost everywhere, re-upload from the locally
     archived canonical JSON (`hashEvidence(...).canonicalJson`) — the CID is
     deterministic so the on-chain reference stays valid.
3. Certification version history is append-only (see
   `docs/certification-versioning.md`); never overwrite a CID in place.

## Tests

`api/src/projects/ipfs-redundancy.spec.ts` simulates a primary-provider outage
(fetch stub rejects) and asserts content remains pinned/verifiable via the
secondary, plus tamper detection via hash mismatch.
