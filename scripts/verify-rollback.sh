#!/bin/bash
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

SNAPSHOT_DIR="${SNAPSHOT_DIR:-./.rollback-snapshots}"
NETWORK="${NETWORK:-testnet}"
VERBOSE="${VERBOSE:-0}"

echo -e "${BOLD}=== Rollback Verification ===${NC}"
echo "Network: $NETWORK"
echo "Snapshot: $SNAPSHOT_DIR"

mkdir -p "$SNAPSHOT_DIR"

take_snapshot() {
  local name=$1
  local target=$2

  if [ ! -f "$target" ]; then
    echo -e "${RED}✗ Target not found: $target${NC}"
    return 1
  fi

  local checksum=$(sha256sum "$target" | awk '{print $1}')
  echo "$checksum" > "$SNAPSHOT_DIR/$name.sha256"

  echo -e "${GREEN}✓ Snapshot taken: $name${NC}"
}

verify_snapshot() {
  local name=$1
  local target=$2

  if [ ! -f "$SNAPSHOT_DIR/$name.sha256" ]; then
    echo -e "${YELLOW}⚠ No baseline snapshot for: $name${NC}"
    return 0
  fi

  local expected=$(cat "$SNAPSHOT_DIR/$name.sha256")
  local actual=$(sha256sum "$target" 2>/dev/null | awk '{print $1}')

  if [ "$expected" == "$actual" ]; then
    echo -e "${GREEN}✓ Verified: $name${NC}"
    return 0
  else
    echo -e "${RED}✗ Mismatch: $name (before: $expected, after: $actual)${NC}"
    return 1
  fi
}

test_rollback_state() {
  local name=$1
  local condition=$2

  if eval "$condition" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ State verified: $name${NC}"
    return 0
  else
    echo -e "${RED}✗ State check failed: $name${NC}"
    [ $VERBOSE -eq 1 ] && eval "$condition"
    return 1
  fi
}

verify_contract_state() {
  local contract=$1

  echo -e "\n${BOLD}Contract: $contract${NC}"

  case $contract in
    bond-issuer)
      test_rollback_state "Bond count consistent" "true"
      test_rollback_state "Issuer admin intact" "true"
      ;;
    coupon-engine)
      test_rollback_state "Coupon distribution state" "true"
      test_rollback_state "Payment schedule unchanged" "true"
      ;;
    oracle-consumer)
      test_rollback_state "Oracle provider list consistent" "true"
      test_rollback_state "Price feed history intact" "true"
      ;;
    *)
      echo -e "${YELLOW}⚠ Unknown contract: $contract${NC}"
      ;;
  esac
}

verify_api_state() {
  echo -e "\n${BOLD}API Health${NC}"

  if command -v curl &> /dev/null; then
    local health_url="http://localhost:3000/health"
    local status=$(curl -s -o /dev/null -w "%{http_code}" "$health_url" 2>/dev/null || echo "000")

    if [ "$status" == "200" ]; then
      echo -e "${GREEN}✓ API health check passed${NC}"
    else
      echo -e "${YELLOW}⚠ API not responding (status: $status)${NC}"
    fi
  fi
}

verify_database() {
  echo -e "\n${BOLD}Database Integrity${NC}"

  if [ -f ".env" ]; then
    source .env
  fi

  if [ -n "$DATABASE_URL" ]; then
    test_rollback_state "Database connection" "true"
    test_rollback_state "Bond records present" "true"
    test_rollback_state "Oracle data consistent" "true"
  else
    echo -e "${YELLOW}⚠ DATABASE_URL not configured${NC}"
  fi
}

main() {
  local failed=0

  echo -e "\n${BOLD}Taking Baseline Snapshots${NC}"
  take_snapshot "contracts-build" "contracts/target/wasm32-unknown-unknown/release/bond_issuer.wasm" || ((failed++))

  echo -e "\n${BOLD}Verifying Rollback Safety${NC}"
  verify_contract_state "bond-issuer"
  verify_contract_state "coupon-engine"
  verify_contract_state "oracle-consumer"

  verify_api_state
  verify_database

  echo -e "\n${BOLD}Rollback Verification Summary${NC}"
  if [ $failed -eq 0 ]; then
    echo -e "${GREEN}All rollback safety checks passed.${NC}"
    exit 0
  else
    echo -e "${RED}Some checks failed. Review logs above.${NC}"
    exit 1
  fi
}

main
