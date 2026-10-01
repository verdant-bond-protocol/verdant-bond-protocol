#!/usr/bin/env bash
#
# On-chain verification for Verdant Bond Protocol contracts.
#
# This script:
#   1. Builds contracts in the deterministic container (or locally if soroban CLI available)
#   2. Fetches deployed contract WASM from the network (testnet/mainnet)
#   3. Compares local build hash against on-chain deployed hash
#   4. Reports any mismatches (potential supply chain compromise or deployment drift)
#
# Usage:
#   scripts/reproducibility/verify-onchain.sh [--network testnet|mainnet] [--container]
#
# Environment:
#   STELLAR_RPC_URL        - RPC endpoint (default: testnet soroban-rpc)
#   NETWORK_PASSPHRASE     - Network passphrase (default: Test SDF Network)
#   DEPLOYED_ADDRESSES_FILE - Path to file with contract_name=address mappings
#
# Exit codes:
#   0 - All contracts match
#   1 - One or more contracts mismatch
#   2 - Configuration/build error
#   3 - Network/RPC error

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Defaults
NETWORK="testnet"
USE_CONTAINER=false
RPC_URL=""
NETWORK_PASSPHRASE=""
DEPLOYED_ADDRESSES_FILE=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --network NETWORK        Target network: testnet or mainnet (default: testnet)
  --container              Use Docker container for deterministic build
  --rpc-url URL            Custom RPC endpoint
  --passphrase PASSPHRASE  Network passphrase
  --addresses-file FILE    File with contract_name=address mappings (default: .env)
  -h, --help               Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --network)
      NETWORK="$2"
      shift 2
      ;;
    --container)
      USE_CONTAINER=true
      shift
      ;;
    --rpc-url)
      RPC_URL="$2"
      shift 2
      ;;
    --passphrase)
      NETWORK_PASSPHRASE="$2"
      shift 2
      ;;
    --addresses-file)
      DEPLOYED_ADDRESSES_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

# Network configuration
case "$NETWORK" in
  testnet)
    RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org:443}"
    NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
    ;;
  mainnet)
    RPC_URL="${RPC_URL:-https://soroban-mainnet.stellar.org:443}"
    NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Public Global Stellar Network ; September 2015}"
    ;;
  *)
    echo "Unknown network: $NETWORK (expected testnet or mainnet)" >&2
    exit 2
    ;;
esac

# Contract name to package name mapping
declare -A PKG_MAP=(
  ["governance"]="nbbs-governance"
  ["project-registry"]="nbbs-project-registry"
  ["bond-issuer"]="nbbs-bonds"
  ["coupon-engine"]="nbbs-coupon-engine"
  ["oracle-consumer"]="nbbs-oracle-consumer"
  ["dex-router"]="nbbs-dex-router"
  ["credit-retirement"]="nbbs-credit-retirement"
)

# WASM file naming
declare -A WASM_NAME=(
  ["governance"]="nbbs_governance.wasm"
  ["project-registry"]="nbbs_project_registry.wasm"
  ["bond-issuer"]="nbbs_bond_issuer.wasm"
  ["coupon-engine"]="nbbs_coupon_engine.wasm"
  ["oracle-consumer"]="nbbs_oracle_consumer.wasm"
  ["dex-router"]="nbbs_dex_router.wasm"
  ["credit-retirement"]="nbbs_credit_retirement.wasm"
)

# Load deployed addresses
if [[ -z "$DEPLOYED_ADDRESSES_FILE" ]]; then
  if [[ -f "$ROOT/.env" ]]; then
    DEPLOYED_ADDRESSES_FILE="$ROOT/.env"
  else
    echo "[ERROR] No addresses file found. Run deployment first or specify --addresses-file" >&2
    exit 2
  fi
fi

get_address() {
  local contract="$1"
  local env_var=""
  case "$contract" in
    governance) env_var="GOVERNANCE_ADDRESS" ;;
    project-registry) env_var="PROJECT_REGISTRY_ADDRESS" ;;
    bond-issuer) env_var="BOND_ISSUER_ADDRESS" ;;
    coupon-engine) env_var="COUPON_ENGINE_ADDRESS" ;;
    oracle-consumer) env_var="ORACLE_CONSUMER_ADDRESS" ;;
    dex-router) env_var="DEX_ROUTER_ADDRESS" ;;
    credit-retirement) env_var="CREDIT_RETIREMENT_ADDRESS" ;;
  esac
  grep "^${env_var}=" "$DEPLOYED_ADDRESSES_FILE" 2>/dev/null | cut -d= -f2
}

# Build contracts
echo "==> Building contracts for $NETWORK verification..."
BUILD_DIR="$ROOT/contracts/target/wasm32-unknown-unknown/release"

if [[ "$USE_CONTAINER" == true ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "[ERROR] Docker not available but --container requested" >&2
    exit 2
  fi
  echo "  Building in deterministic container..."
  docker build -t verdant-bond-contracts:verify -f "$ROOT/contracts/Dockerfile" "$ROOT/contracts" >/dev/null
  docker run --rm \
    -v "$ROOT/contracts:/workspace" \
    verdant-bond-contracts:verify \
    cp /workspace/target/wasm32-unknown-unknown/release/nbbs_*.wasm /workspace/target/wasm32-unknown-unknown/release/
else
  if ! command -v soroban >/dev/null 2>&1; then
    echo "[ERROR] soroban CLI not found. Install it or use --container" >&2
    exit 2
  fi
  echo "  Building locally with soroban CLI..."
  (cd "$ROOT/contracts" && soroban contract build --release --locked >/dev/null)
fi

if [[ ! -d "$BUILD_DIR" ]]; then
  echo "[ERROR] Build directory not found: $BUILD_DIR" >&2
  exit 2
fi

# Compute local hashes
echo "==> Computing local WASM hashes..."
declare -A LOCAL_HASHES
for contract in "${!PKG_MAP[@]}"; do
  wasm_file="$BUILD_DIR/${WASM_NAME[$contract]}"
  if [[ ! -f "$wasm_file" ]]; then
    echo "[ERROR] WASM not found: $wasm_file" >&2
    exit 2
  fi
  LOCAL_HASHES[$contract]=$(sha256sum "$wasm_file" | cut -d' ' -f1)
  echo "  $contract: ${LOCAL_HASHES[$contract]}"
done

# Fetch on-chain contract hashes
echo "==> Fetching on-chain contract hashes from $NETWORK..."
declare -A ONCHAIN_HASHES
mismatches=0

for contract in "${!PKG_MAP[@]}"; do
  address=$(get_address "$contract")
  if [[ -z "$address" ]]; then
    echo "  [SKIP] $contract: not deployed (no address in $DEPLOYED_ADDRESSES_FILE)"
    continue
  fi

  echo "  Querying $contract at $address..."

  # Use soroban CLI to fetch contract code hash
  # soroban contract fetch --id <address> --network <network> --rpc-url <url>
  # The output includes the code hash
  if [[ "$USE_CONTAINER" == true ]]; then
    # Run soroban in container
    hash=$(docker run --rm \
      -v "$ROOT/contracts:/workspace" \
      verdant-bond-contracts:verify \
      soroban contract fetch \
        --id "$address" \
        --network "$NETWORK" \
        --rpc-url "$RPC_URL" 2>/dev/null | grep -i "code hash" | awk '{print $NF}' || true)
  else
    hash=$(soroban contract fetch \
      --id "$address" \
      --network "$NETWORK" \
      --rpc-url "$RPC_URL" 2>/dev/null | grep -i "code hash" | awk '{print $NF}' || true)
  fi

  if [[ -z "$hash" ]]; then
    echo "    [WARN] Could not fetch code hash for $contract (may need different RPC method)"
    # Alternative: fetch the WASM and hash it
    wasm_output="/tmp/${contract}_onchain.wasm"
    if [[ "$USE_CONTAINER" == true ]]; then
      docker run --rm \
        -v "$ROOT/contracts:/workspace" \
        verdant-bond-contracts:verify \
        soroban contract fetch \
          --id "$address" \
          --network "$NETWORK" \
          --rpc-url "$RPC_URL" \
          --output "$wasm_output" 2>/dev/null || true
    else
      soroban contract fetch \
        --id "$address" \
        --network "$NETWORK" \
        --rpc-url "$RPC_URL" \
        --output "$wasm_output" 2>/dev/null || true
    fi

    if [[ -f "$wasm_output" ]]; then
      hash=$(sha256sum "$wasm_output" | cut -d' ' -f1)
      rm -f "$wasm_output"
    fi
  fi

  if [[ -z "$hash" ]]; then
    echo "    [ERROR] Failed to fetch on-chain hash for $contract"
    mismatches=$((mismatches + 1))
    continue
  fi

  ONCHAIN_HASHES[$contract]="$hash"
  echo "    On-chain: $hash"
  echo "    Local:    ${LOCAL_HASHES[$contract]}"

  if [[ "${LOCAL_HASHES[$contract]}" == "$hash" ]]; then
    echo "    ✓ MATCH"
  else
    echo "    ✗ MISMATCH!"
    mismatches=$((mismatches + 1))
  fi
done

echo ""
echo "=== Verification Summary ==="
echo "Network: $NETWORK"
echo "RPC: $RPC_URL"

if [[ $mismatches -eq 0 ]]; then
  echo "✅ All deployed contracts match local builds!"
  exit 0
else
  echo "❌ $mismatches contract(s) have hash mismatches!"
  echo ""
  echo "Possible causes:"
  echo "  - Contract was upgraded after the source commit"
  echo "  - Build non-determinism (different toolchain, env, paths)"
  echo "  - Supply chain compromise (malicious dependency)"
  echo "  - Different compiler flags or features"
  exit 1
fi