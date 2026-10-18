#!/bin/bash
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BOLD}=== Verdant Bond Protocol Diagnostics ===${NC}\n"

PASS=0
FAIL=0
WARN=0

check() {
  local name=$1
  local cmd=$2
  local min_version=$3

  if output=$($cmd 2>&1); then
    echo -e "${GREEN}✓${NC} $name: $output"
    ((PASS++))
    return 0
  else
    echo -e "${RED}✗${NC} $name: ${output:-command failed}"
    ((FAIL++))
    return 1
  fi
}

check_version() {
  local name=$1
  local cmd=$2
  local min=$3

  if output=$($cmd 2>&1); then
    echo -e "${GREEN}✓${NC} $name: $output"
    ((PASS++))
    return 0
  else
    echo -e "${RED}✗${NC} $name: required (minimum $min)"
    ((FAIL++))
    return 1
  fi
}

echo -e "${BOLD}Required Tools:${NC}"
check_version "Node.js (v18+)" "node --version" "18.0.0"
check_version "npm (v9+)" "npm --version" "9.0.0"
check_version "Rust (stable)" "rustc --version" "1.70.0"
check_version "Cargo" "cargo --version" "1.70.0"
check "Git" "git --version" ""

echo -e "\n${BOLD}Optional Tools:${NC}"
check "Soroban CLI" "soroban --version" "" || ((WARN++))
check "Docker" "docker --version" "" || ((WARN++))

echo -e "\n${BOLD}Dependencies:${NC}"
[ -d "contracts/target" ] && echo -e "${GREEN}✓${NC} Contracts built" || echo -e "${YELLOW}⚠${NC} Contracts not built (run: cd contracts && cargo build)"
[ -f "api/node_modules/.package-lock.json" ] && echo -e "${GREEN}✓${NC} API dependencies installed" || echo -e "${YELLOW}⚠${NC} API not installed (run: cd api && npm ci)"
[ -f "frontend/node_modules/.package-lock.json" ] && echo -e "${GREEN}✓${NC} Frontend dependencies installed" || echo -e "${YELLOW}⚠${NC} Frontend not installed (run: cd frontend && npm ci)"
[ -f "oracle/node_modules/.package-lock.json" ] && echo -e "${GREEN}✓${NC} Oracle dependencies installed" || echo -e "${YELLOW}⚠${NC} Oracle not installed (run: cd oracle && npm ci)"

echo -e "\n${BOLD}Environment Configuration:${NC}"
[ -f "api/.env" ] && echo -e "${GREEN}✓${NC} API .env configured" || echo -e "${YELLOW}⚠${NC} API .env missing (copy from .env.example)"

echo -e "\n${BOLD}Summary:${NC}"
echo -e "Passed: ${GREEN}$PASS${NC} | Failed: ${RED}$FAIL${NC} | Warnings: ${YELLOW}$WARN${NC}"

if [ $FAIL -gt 0 ]; then
  echo -e "\n${RED}Diagnostic failed. Install missing dependencies and retry.${NC}"
  exit 1
elif [ $WARN -gt 0 ]; then
  echo -e "\n${YELLOW}Some optional tools missing. Non-critical.${NC}"
  exit 0
else
  echo -e "\n${GREEN}All checks passed. Environment ready.${NC}"
  exit 0
fi
