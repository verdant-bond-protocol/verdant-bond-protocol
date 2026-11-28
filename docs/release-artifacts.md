# Reproducible Release Artifacts & Verification (#538)

Code: `api/src/release/release-artifact-manifest.ts`, CLI `api/scripts/release-artifacts.ts`
Tests: `api/src/release/release-artifact-manifest.spec.ts`

[reproducible-builds.md](reproducible-builds.md) covers making the contract
WASM reproducible. This adds a release **manifest** that pins every shipped
artifact (contract WASM, API bundle, anything in the release directory) to
its build provenance, and a verifier for independent rebuilds or downloads.

## Manifest

```json
{
  "artifacts": [{ "path": "nbbs_bond_issuer.wasm", "sha256": "…", "size": 41234 }],
  "digest": "<sha256 of the canonical manifest body>",
  "provenance": {
    "commit": "<git sha>",
    "lockfiles": { "api/package-lock.json": "<sha256>", "contracts/Cargo.lock": "<sha256>" },
    "toolchain": { "node": "v20.11.0", "rust": "1.97.1" }
  },
  "release": "v1.4.0",
  "schemaVersion": 1,
  "signature": { "keyId": "release-2026", "hmacSha256": "…" }
}
```

It is deterministic: artifacts are sorted, keys are canonical, and file
collection order does not matter. The same inputs give byte-identical JSON.

## Usage

```bash
cd api
# After building the release directory:
RELEASE_MANIFEST_KEY_ID=release-2026 RELEASE_MANIFEST_KEY=*** \
  npx ts-node --transpile-only scripts/release-artifacts.ts generate \
    --release v1.4.0 --root ../contracts/target/wasm32-unknown-unknown/release --commit "$GITHUB_SHA"

# An auditor rebuilds at the same commit and verifies:
RELEASE_MANIFEST_TRUSTED_KEYS=release-2026=*** \
  npx ts-node --transpile-only scripts/release-artifacts.ts verify \
    --manifest release-manifest.json --root <rebuilt dir> --expect-commit <sha>
```

Exit codes: `0` verified, `1` failed, `2` usage error, `3` retryable.

## What verification checks

All discrepancies are reported together, not just the first.

- `digestValid`: manifest body unchanged since it was built (and schema version known).
- `signature`: `valid`, `missing`, `invalid` or `unknown_key`. With trusted keys
  configured, anything but `valid` fails. Without keys, an unsigned manifest
  is accepted (integrity only, no authenticity).
- `missing` / `unexpected`: artifacts absent from, or extra in, the candidate.
- `mismatched`: sha256 or size differs.
- `provenanceDrift`: commit, toolchain or lockfile hash differs from the expected provenance.
- `unreadable`: an artifact could not be read. If that is the **only** problem,
  `retryable: true` and exit code `3`, so the run can simply be repeated.

## Edge cases

- Absolute paths, `..` segments, empty segments and duplicate paths (including
  `./a` vs `a`) are refused when building.
- The CLI never follows symlinks while collecting files, so a link cannot pull
  files from outside the release root into the manifest.
- **Rotating the signing key:** add the new key to the trusted set, sign new
  releases with it, and keep the old key trusted for as long as its releases
  must stay verifiable.
- **Rolling back:** the manifest is a separate file. Deleting it, or not passing
  trusted keys, returns to the previous checksum-only flow in
  [reproducible-builds.md](reproducible-builds.md).

## Note on the existing container check

`.github/workflows/reproducible-builds.yml` runs
`sha256sum -c checksums.sha256 || true`, so the hermetic check can never fail
the job. `contracts/checksums.sha256` is not committed yet. Once a baseline
manifest is committed, that `|| true` can be dropped.
