#!/usr/bin/env bash
set -euo pipefail

# ── Source environment ──────────────────────────────────────────
ENV_FILE="${ENV_FILE:-.env.mainnet}"
if [ -f "$ENV_FILE" ]; then
  echo "Sourcing ${ENV_FILE}"
  set -a
  source "$ENV_FILE"
  set +a
fi

# ── Logging ─────────────────────────────────────────────────────
LOG_FILE="deploy-mainnet-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

# ── Configuration ───────────────────────────────────────────────
NETWORK=mainnet
ADMIN_ADDRESS="${STELLAR_PUBLIC_KEY:?STELLAR_PUBLIC_KEY not set}"
CONTRACTS=(
  "shared"
  "governance"
  "project-registry"
  "bond-issuer"
  "coupon-engine"
  "oracle-consumer"
  "dex-router"
  "credit-retirement"
)

declare -A PKG_MAP=(
  ["shared"]="nbbs-shared"
  ["governance"]="nbbs-governance"
  ["project-registry"]="nbbs-project-registry"
  ["bond-issuer"]="nbbs-bonds"
  ["coupon-engine"]="nbbs-coupon-engine"
  ["oracle-consumer"]="nbbs-oracle-consumer"
  ["dex-router"]="nbbs-dex-router"
  ["credit-retirement"]="nbbs-credit-retirement"
)

declare -A ENV_MAP=(
  ["governance"]="GOVERNANCE_ADDRESS"
  ["project-registry"]="PROJECT_REGISTRY_ADDRESS"
  ["bond-issuer"]="BOND_ISSUER_ADDRESS"
  ["coupon-engine"]="COUPON_ENGINE_ADDRESS"
  ["oracle-consumer"]="ORACLE_CONSUMER_ADDRESS"
  ["dex-router"]="DEX_ROUTER_ADDRESS"
  ["credit-retirement"]="CREDIT_RETIREMENT_ADDRESS"
)

# Read a value back from the env file (updated as deployment progresses)
get_env_value() {
  grep "^${1}=" "$ENV_FILE" 2>/dev/null | cut -d= -f2
}

echo ""
echo "⚠️  ⚠️  ⚠️  MAINNET DEPLOYMENT ⚠️  ⚠️  ⚠️"
echo ""
echo "Network:  ${NETWORK}"
echo "Admin:    ${ADMIN_ADDRESS}"
echo "Log file: ${LOG_FILE}"
echo ""
echo "⚠️  This will deploy REAL contracts to MAINNET."
echo "⚠️  Ensure contracts have been audited before proceeding."
echo ""

for contract in "${CONTRACTS[@]}"; do
  pkg="${PKG_MAP[$contract]}"
  wasm_name="${contract//-/_}"
  wasm="target/wasm32-unknown-unknown/release/nbbs_${wasm_name}.wasm"

  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo "  NEXT: ${contract}"
  echo "══════════════════════════════════════════════════════════════"
  read -p "Continue? (y/N) " -r confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "  ✗ Skipped ${contract}"
    continue
  fi

  echo "── ${contract} ──"

  if [ "$contract" = "shared" ]; then
    echo "  ↪ Building shared library..."
    (cd contracts && soroban contract build --package "$pkg")
    echo "  ✓ Done (library only, no deployment)"
    continue
  fi

  echo "  Building..."
  (cd contracts && soroban contract build --package "$pkg")

  echo "  Deploying..."
  address=$(soroban contract deploy \
    --wasm "contracts/${wasm}" \
    --network "$NETWORK")

  echo "  Address: ${address}"

  echo "  Initializing..."
  constructor_args=()
  case "$contract" in
    governance)
      # governance: signers (Vec<Address>), threshold (u32), timelock_seconds (u64)
      # Initialize with admin as sole signer, threshold=1, 48h timelock
      constructor_args=(--arg "$ADMIN_ADDRESS" --arg "1" --arg "172800")
      ;;
    project-registry|bond-issuer|coupon-engine|oracle-consumer)
      # Use governance contract as admin for 3-of-5 multisig + 48h timelock control
      governance_addr="$(get_env_value GOVERNANCE_ADDRESS)"
      if [ -z "$governance_addr" ]; then
        echo "  ✗ ERROR: GOVERNANCE_ADDRESS not set. Governance must be deployed first."
        exit 1
      fi
      constructor_args=(--arg "$governance_addr")
      ;;
    dex-router|credit-retirement)
      # Use governance as admin, plus dependency addresses
      governance_addr="$(get_env_value GOVERNANCE_ADDRESS)"
      if [ -z "$governance_addr" ]; then
        echo "  ✗ ERROR: GOVERNANCE_ADDRESS not set. Governance must be deployed first."
        exit 1
      fi
      constructor_args=(
        --arg "$governance_addr"
        --arg "$(get_env_value BOND_ISSUER_ADDRESS)"
        --arg "$(get_env_value COUPON_ENGINE_ADDRESS)"
      )
      ;;
  esac
  soroban contract invoke \
    --id "$address" \
    --fn __constructor \
    "${constructor_args[@]}" \
    --network "$NETWORK"

  env_key="${ENV_MAP[$contract]}"
  if grep -q "^#\?${env_key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s/^#\?${env_key}=.*/${env_key}=${address}/" "$ENV_FILE"
  else
    echo "${env_key}=${address}" >> "$ENV_FILE"
  fi

  echo "  ✓ ${contract} → ${env_key}=${address}"
done

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  All contracts deployed to ${NETWORK}"
echo "══════════════════════════════════════════════════════════════"
for contract in "${CONTRACTS[@]}"; do
  env_key="${ENV_MAP[$contract]}"
  if [ -n "${env_key:-}" ]; then
    echo "  ${env_key}=$(grep "^${env_key}=" "$ENV_FILE" | cut -d= -f2)"
  fi
done
echo "══════════════════════════════════════════════════════════════"
echo ""

# ── Post-Deployment Verification ───────────────────────────────
echo "══════════════════════════════════════════════════════════════"
echo "  POST-DEPLOYMENT VERIFICATION"
echo "══════════════════════════════════════════════════════════════"
echo ""

GOVERNANCE_ADDRESS="$(get_env_value GOVERNANCE_ADDRESS)"
EXPECTED_ADMIN="$GOVERNANCE_ADDRESS"

# Contracts that should have governance as admin
ADMIN_CONTRACTS=("project-registry" "bond-issuer" "coupon-engine" "oracle-consumer" "dex-router" "credit-retirement")

for contract in "${ADMIN_CONTRACTS[@]}"; do
  env_key="${ENV_MAP[$contract]}"
  contract_addr="$(get_env_value "$env_key")"
  
  if [ -z "$contract_addr" ]; then
    echo "  ✗ ${contract}: address not found in ${ENV_FILE}"
    continue
  fi
  
  echo "  Verifying ${contract}..."
  stored_admin=$(soroban contract invoke \
    --id "$contract_addr" \
    --fn get_admin \
    --network "$NETWORK" 2>/dev/null | sed 's/"//g' | tr -d '[:space:]') || true
  
  if [ "$stored_admin" = "$EXPECTED_ADMIN" ]; then
    echo "    ✓ Admin is governance (${GOVERNANCE_ADDRESS:0:10}...)"
  else
    echo "    ⚠️  Admin mismatch:"
    echo "       Expected: ${EXPECTED_ADMIN:0:10}..."
    echo "       Got:      ${stored_admin:0:10}..."
  fi
done

echo ""
echo "══════════════════════════════════════════════════════════════"
echo ""
echo "⚠️  Verify contract addresses on Stellar Expert before using in production"
echo "  Log saved to ${LOG_FILE}"
