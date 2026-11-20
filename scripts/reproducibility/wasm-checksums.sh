#!/usr/bin/env bash
#
# Verify that the Soroban contract build is reproducible by hashing every
# deployable WASM artifact and comparing against a committed manifest
# (contracts/checksums.sha256).
#
# Modes:
#   --generate   rebuild and write contracts/checksums.sha256 (first baseline)
#   --verify     rebuild and compare hashes against the committed manifest
#                (default; fails if the manifest is absent or mismatched)
#
# Usage: scripts/reproducibility/wasm-checksums.sh [--generate]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/contracts"

MANIFEST="checksums.sha256"
RELEASE_DIR="target/wasm32-unknown-unknown/release"

MODE="${1:---verify}"

if ! command -v soroban >/dev/null 2>&1; then
  echo "  [skip] soroban CLI not available; skipping WASM checksum build." >&2
  exit 0
fi

echo "==> Building Soroban contracts (release)..."
soroban contract build --release >/dev/null

if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "  [FAIL] No WASM artifacts produced in $RELEASE_DIR"
  exit 1
fi

# Hash every deployable artifact (nbbs_*.wasm), sorted for a stable manifest.
shopt -s nullglob
wasms=( "$RELEASE_DIR"/nbbs_*.wasm )
if [[ ${#wasms[@]} -eq 0 ]]; then
  echo "  [FAIL] No nbbs_*.wasm deployable artifacts found in $RELEASE_DIR"
  exit 1
fi

generate_manifest() {
  : > "$MANIFEST"
  for wasm in "${wasms[@]}"; do
    (cd "$RELEASE_DIR" && sha256sum "$(basename "$wasm")") >> "$ROOT/contracts/$MANIFEST"
  done
}

case "$MODE" in
  --generate)
    generate_manifest
    echo ""
    echo "Wrote $ROOT/contracts/$MANIFEST with ${#wasms[@]} artifact checksum(s)."
    ;;
  --verify)
    if [[ ! -f "$MANIFEST" ]]; then
      echo "  [FAIL] No committed $MANIFEST found. Run with --generate to create the baseline."
      exit 1
    fi
    if ! (cd "$RELEASE_DIR" && sha256sum -c "$ROOT/contracts/$MANIFEST" >/dev/null 2>&1); then
      echo "  [FAIL] WASM artifacts do not match the committed checksum manifest."
      echo "         Builds are NOT reproducible. Investigate non-determinism (timestamps,"
      echo "         build paths, toolchain version) or update the manifest deliberately."
      exit 1
    fi
    echo ""
    echo "WASM checksums verified (${#wasms[@]} artifact(s) reproducible)."
    ;;
  *)
    echo "Unknown mode: $MODE (expected --generate or --verify)" >&2
    exit 2
    ;;
esac
