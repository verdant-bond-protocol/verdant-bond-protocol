# Cryptographic verification of imported external evidence (#393)

Oracle reports reach the protocol with two pieces of external evidence:

- an optional **evidence manifest**, the provider's signed summary of the
  measurement (`SubmitReportDto.manifest`, #113);
- an optional **evidence reference** (`evidenceHash`, a CIDv0 or hex SHA-256)
  that is anchored on-chain as `ipfs_evidence_hash` (#93).

Before #393 the manifest was signed with HMAC under **one secret shared by
every provider** (`DEFAULT_MANIFEST_SECRET`). That signature cannot tell
providers apart. The evidence reference was checked only for *retrievability*:
a gateway answering `200` with different bytes passed. Both checks are now
cryptographic.

Code: `api/src/oracle/evidence-verification.ts`, wired into
`OracleService.submitReport`.
Tests: `api/src/oracle/evidence-verification.spec.ts`.

## 1. Authenticity: ed25519 manifests

A manifest with `"signature_scheme": "ed25519"` is verified as follows:

1. **Schema** is the existing `EvidenceManifestSchema`, plus the optional
   `signature_scheme` and `evidence_hash` fields.
2. **Signer** (`signer_public_key`) must be a Stellar `G…` key, and it must be
   **the submitting provider** or one of its delegated signers
   (`ORACLE_EVIDENCE_DELEGATED_SIGNERS`).
3. **Signature** is an ed25519 signature, hex (128 chars) or base64, over
   `canonicalJson(manifest without "signature")`, the same canonical
   serialization the HMAC scheme uses.
4. **Freshness**: `generated_at` may be at most 5 minutes in the future
   (clock skew). If `ORACLE_EVIDENCE_MAX_AGE_SECONDS` is set, it may not be
   older than that.
5. **Binding**: if the manifest signs an `evidence_hash`, it must equal the
   report's `evidenceHash`. A signed manifest then cannot be attached to
   different evidence.

The existing value check (`verifyManifestMatchesReport`: project, methodology,
period, quantity) still runs after the signature check.

Producing one (provider tooling):

```ts
import { Keypair } from '@stellar/stellar-sdk';
import { signManifestEd25519 } from 'api/src/oracle/evidence-verification';

const manifest = signManifestEd25519({ ...fields, evidence_hash: cid }, Keypair.fromSecret(PROVIDER_SECRET));
```

### Authorization

`POST /oracle/reports` identifies the provider by the `x-provider-address`
header ("wallet-header" in `route-authorization-matrix.md`). Anyone can set a
header. An ed25519 manifest must be signed by that provider's key or its
delegate, so a caller who spoofs the header cannot present a valid manifest.
With `ORACLE_EVIDENCE_SIGNATURE_MODE=required`, every report needs one. That
turns the header claim into a cryptographic proof of possession of the
provider key.

Delegation (`ORACLE_EVIDENCE_DELEGATED_SIGNERS`):

```json
{ "GPROVIDER...": ["GSIGNINGKEY1...", "GSIGNINGKEY2..."] }
```

Delegation lets a provider sign with a hot key and keep its account key
offline. Invalid JSON or non-`G` keys are ignored: nothing extra becomes
trusted.

## 2. Integrity: evidence content

With `ORACLE_EVIDENCE_VERIFY_CONTENT=true`, a CIDv0 `evidenceHash` is fetched
from `IPFS_GATEWAY` **before** anything is pinned or sent on-chain. The bytes
must hash to the reference's digest, either as raw bytes or, for JSON
evidence, as the SHA-256 of its canonical serialization. The second form is
the convention `ipfs/evidence.ts` uses to produce references. This supersedes
`ORACLE_EVIDENCE_VERIFY_RETRIEVABILITY`, which keeps its old behaviour when
used alone.

Hex-digest references name no gateway object and are skipped, as before.

## Rejections

Every rejection is `422` with a stable `evidenceCode` in the body. A
rejection happens before IPFS upload and before the contract call, so a
rejected report leaves no state behind.

| `evidenceCode` | Meaning | Retry? |
|---|---|---|
| `SCHEMA_INVALID` | Manifest shape or `generated_at` is invalid | no, fix the manifest |
| `SIGNER_INVALID` | `signer_public_key` is not a Stellar key | no |
| `SIGNER_UNTRUSTED` | Signer is neither the provider nor its delegate | no, check the delegation config |
| `SIGNATURE_MALFORMED` / `SIGNATURE_INVALID` | Signature is unparsable or does not verify | no, re-sign |
| `GENERATED_IN_FUTURE` / `MANIFEST_EXPIRED` | Freshness check failed | re-sign with a correct clock |
| `EVIDENCE_BINDING_MISMATCH` | Signed `evidence_hash` ≠ report `evidenceHash` | no |
| `LEGACY_SCHEME_REJECTED` | HMAC manifest in `ed25519` / `required` mode | re-sign as ed25519 |
| `MANIFEST_REQUIRED` | `required` mode and no manifest | attach one |
| `DIGEST_MISMATCH` | Gateway content ≠ referenced digest | not automatically; see below |
| `NOT_RETRIEVABLE` | 4xx, or transient failures exhausted | yes, later |
| `TOO_LARGE` | Above `ORACLE_EVIDENCE_MAX_BYTES` (default 10 MiB) | no |

### Retry behaviour

The gateway fetch retries **only transient failures**: network errors,
timeouts, and `408/425/429/5xx`. It makes up to `ORACLE_EVIDENCE_FETCH_ATTEMPTS`
attempts (default 3), with linear backoff of 250 ms × attempt and
`ORACLE_EVIDENCE_RETRIEVABILITY_TIMEOUT_MS` per attempt (default 5 s).
Deterministic failures return immediately: a digest mismatch, any other 4xx,
or oversize content. Retrying them would fetch the same wrong bytes again.

Resubmitting a rejected report is always safe. Nothing was pinned or anchored,
and the nonce was not consumed.

## Operational edge cases

- **`DIGEST_MISMATCH` on genuine evidence.** The gateway may be serving a
  different object, for example a dag-pb wrapped file whose CID is not
  `sha256(bytes)`. Check the reference with `ipfs/evidence.ts`
  (`hashEvidence`) against the original file. If the gateway itself is
  compromised, point `IPFS_GATEWAY` at another one. Do **not** turn off
  content verification to let one report through: that anchors unverified
  evidence permanently.
- **Gateway outage.** Reports fail with `NOT_RETRIEVABLE` and can be retried.
  Switching gateways is safe because the check is content-addressed and does
  not depend on which gateway answers.
- **Key rotation.** Add the new signing key to
  `ORACLE_EVIDENCE_DELEGATED_SIGNERS` and deploy. Switch the provider's tooling
  to it, then remove the old key. Manifests already verified stay valid: the
  check happens at submission and is not repeated later.
- **Compromised signing key.** Remove it from the delegation map and redeploy.
  Reports already anchored with it go through the normal challenge flow
  (`docs/oracle-challenge-lifecycle.md`).
- **Clock skew.** Up to 5 minutes into the future is tolerated. Larger skew on
  the provider host gives `GENERATED_IN_FUTURE`.

## Rollout, migration and rollback

The default is unchanged behaviour. `ORACLE_EVIDENCE_SIGNATURE_MODE` defaults
to `legacy`, which still accepts HMAC manifests and reports without a
manifest. An ed25519 manifest is verified as soon as it is sent, in every mode.

1. **Migrate providers.** Ship `signManifestEd25519` in provider tooling and
   accept both schemes (`legacy`).
2. Enable `ORACLE_EVIDENCE_VERIFY_CONTENT=true` once gateway latency allows.
3. Switch to `ORACLE_EVIDENCE_SIGNATURE_MODE=ed25519`. Manifests must now be
   ed25519, but they are still optional.
4. Switch to `required` once every provider attaches a manifest.

**Rollback**: step each variable back (`required` → `ed25519` → `legacy`,
`VERIFY_CONTENT` → unset) and restart. No data migration is involved. The
on-chain report layout and `SubmitReportDto` are unchanged, and the two new
manifest fields are optional.
