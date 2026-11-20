#!/usr/bin/env bash
#
# Reproducibility gate for Verdant Bond Protocol.
#
# Verifies that:
#   1. Every Node package ships a committed, in-sync lockfile and the Rust
#      workspace pins Cargo.lock (scripts/reproducibility/lockfiles.sh).
#   2. When the Soroban CLI is available, contract WASM artifacts match the
#      committed checksum manifest (scripts/reproducibility/wasm-checksums.sh).
#
# Usage: scripts/reproducibility/verify.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "⚙️  Verdon Bond Protocol — reproducibility check"
echo ""

"$ROOT/scripts/reproducibility/lockfiles.sh"
lock_rc=$?

if command -v soroban >/dev/null 2>&1; then
  "$ROOT/scripts/reproducibility/wasm-checksums.sh" --verify
  wasm_rc=$?
else
  echo "==> soroban CLI not found; skipping WASM checksum verification (run locally before release)."
  wasm_rc=0
fi

echo ""
if [[ "$lock_rc" -eq 0 && "$wasm_rc" -eq 0 ]]; then
  echo "✅ Reproducibility checks passed."
  exit 0
fi
echo "❌ Reproducibility checks FAILED."
exit 1
