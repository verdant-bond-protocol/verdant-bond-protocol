#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo "   Verdant Bond Protocol — End-to-End Lifecycle Test     "
echo "=========================================================="

# 1. Check toolchain
echo "[1/5] Verifying toolchain..."
cargo --version
node --version
npm --version

# 2. Build smart contracts
echo "[2/5] Compiling smart contracts..."
cd contracts
cargo build --target wasm32-unknown-unknown --release
cd ..

# 3. Setup E2E wallets and fund them via Friendbot
echo "[3/5] Setting up temporary keys and funding them..."
# Run npm install in root / scripts first if needed, but we can do it via ts-node in api
cd api
npm ci --silent
npx ts-node ../scripts/setup-e2e-env.ts
cd ..

# 4. Deploy contracts to Stellar Testnet
echo "[4/5] Deploying contracts to Testnet..."
./scripts/deploy-testnet.sh

# 5. Run the E2E Jest lifecycle test
echo "[5/5] Executing E2E lifecycle test..."
cd api
npx jest test/lifecycle.e2e-spec.ts --runInBand

echo "=========================================================="
echo "   ✓ ALL E2E LIFECYCLE TESTS PASSED SUCCESSFULLY!        "
echo "=========================================================="
