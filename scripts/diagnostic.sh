#!/usr/bin/env bash

# Root entry point for contributor diagnostics. The tested implementation lives
# in api/scripts/diagnostics.ts; this wrapper keeps invocation independent of
# the caller's current directory and forwards flags such as --json and
# --no-retry unchanged.
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v npm >/dev/null 2>&1; then
  printf 'Contributor diagnostics requires npm. Install Node.js 18+ and retry.\n' >&2
  exit 1
fi

if [[ ! -f "$ROOT_DIR/api/package.json" ]]; then
  printf 'Contributor diagnostics could not find api/package.json. Run it from a complete repository checkout.\n' >&2
  exit 1
fi

exec npm --prefix "$ROOT_DIR/api" run diagnostics -- "$@"
