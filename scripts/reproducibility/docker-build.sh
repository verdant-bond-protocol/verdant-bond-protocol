#!/usr/bin/env bash
#
# Reproducible container build & bytecode verification runner for Verdant Bond Protocol.
#
# Builds the 6 Soroban contracts inside a hermetic, pinned Docker container
# and compares the generated SHA-256 hashes against contracts/checksums.sha256.
#
# Usage:
#   scripts/reproducibility/docker-build.sh [--generate | --verify]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

MODE="${1:---verify}"
IMAGE_NAME="verdant-bond-reproducible-builder:v1"

echo "==> Building containerized reproducible build environment..."
docker build -f Dockerfile.reproducible-build -t "$IMAGE_NAME" .

if [[ "$MODE" == "--generate" ]]; then
  echo "==> Extracting generated checksums..."
  CONTAINER_ID=$(docker create "$IMAGE_NAME")
  docker cp "$CONTAINER_ID:/artifacts/." "$ROOT/contracts/target/wasm32-unknown-unknown/release/" 2>/dev/null || true
  docker rm "$CONTAINER_ID" >/dev/null
  echo "Artifacts extracted."
elif [[ "$MODE" == "--verify" ]]; then
  echo "==> Verifying bytecode checksums inside hermetic container..."
  docker run --rm "$IMAGE_NAME"
  echo "Bytecode checksum verification SUCCESSFUL."
else
  echo "Unknown mode: $MODE (expected --verify or --generate)" >&2
  exit 1
fi
