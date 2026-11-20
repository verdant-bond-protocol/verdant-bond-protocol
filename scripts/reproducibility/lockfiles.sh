#!/usr/bin/env bash
#
# Verify that every Node package ships with a committed, in-sync lockfile, and
# that the Rust contract workspace pins its dependency tree via Cargo.lock.
#
# This is a reproducibility gate: unreproducible builds are usually caused by
# drift between package.json (ranges) and the committed lockfile, or a missing
# lockfile that lets resolution vary between machines. Running `npm ci` (used
# by CI and this check) resolves strictly from the lockfile, so an out-of-sync
# lockfile is surfaced here as an explicit failure.
#
# Usage: scripts/reproducibility/lockfiles.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

declare -a NODE_PACKAGES=("api" "frontend" "oracle")

failures=0

echo "==> Checking Node lockfiles (package-lock.json) are present and in sync"

for pkg in "${NODE_PACKAGES[@]}"; do
  lockfile="$pkg/package-lock.json"
  if [[ ! -f "$lockfile" ]]; then
    echo "  [FAIL] $pkg is missing a committed $lockfile (unreproducible resolve)"
    failures=$((failures + 1))
    continue
  fi

  echo "  [check] $pkg — validating lockfile against package.json (npm ci --dry-run)..."
  if ! (cd "$pkg" && npm ci --dry-run --ignore-scripts >/dev/null 2>&1); then
    echo "  [FAIL] $pkg lockfile is out of sync with package.json"
    failures=$((failures + 1))
  else
    echo "  [ok]   $pkg lockfile is in sync"
  fi
done

echo "==> Checking Rust workspace pins Cargo.lock"

if [[ -f "contracts/Cargo.lock" ]]; then
  echo "  [ok]   contracts/Cargo.lock is committed"
else
  echo "  [FAIL] contracts/Cargo.lock is missing (unreproducible contract builds)"
  failures=$((failures + 1))
fi

if [[ "$failures" -gt 0 ]]; then
  echo ""
  echo "Lockfile reproducibility check FAILED with $failures problem(s)."
  exit 1
fi

echo ""
echo "Lockfiles reproducible."
