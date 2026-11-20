#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$root/contracts/governance-sandbox/tests/fixture/Cargo.toml"
cargo build --manifest-path "$fixture" --target-dir "$root/contracts/governance-sandbox/tests/fixture/target" --target wasm32v1-none --release
export SANDBOX_FIXTURE_WASM="$root/contracts/governance-sandbox/tests/fixture/target/wasm32v1-none/release/sandbox_runtime_fixture.wasm"
cargo test --manifest-path "$root/contracts/governance-sandbox/Cargo.toml"
