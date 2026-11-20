# Reproducible Builds & On-Chain Bytecode Verification

This guide explains how developers, auditors, and investors can independently reproduce, compile, and verify that the on-chain Soroban contract bytecode for the **Verdant Bond Protocol** matches the published open-source repository commit.

---

## 1. Reproducibility Principles

Reproducible builds ensure that anyone compiling the source code at a specific commit hash will produce bit-for-bit identical WebAssembly (`.wasm`) binaries as deployed on the Stellar network.

To achieve bit-for-bit determinism:
- **Pinned Compiler Toolchain**: The Rust compiler channel, version (`1.97.1`), components, and target (`wasm32-unknown-unknown`) are explicitly pinned in [`rust-toolchain.toml`](../rust-toolchain.toml) and [`contracts/rust-toolchain.toml`](../contracts/rust-toolchain.toml).
- **Immutable Dependency Tree**: All Rust workspace crate dependencies and transitive dependencies are locked via [`contracts/Cargo.lock`](../contracts/Cargo.lock).
- **Hermetic Container Environment**: A pinned [`Dockerfile.reproducible-build`](../Dockerfile.reproducible-build) eliminates host-specific environmental discrepancies (timestamps, absolute filesystem paths, local tool variations).
- **Deterministic Compilation Flags**: `RUSTFLAGS="--remap-path-prefix=/workspace=/build -C debuginfo=0"` strips host path metadata and debug symbols.

---

## 2. Pinned Protocol Contracts

The protocol comprises 6 core smart contracts:
1. `nbbs_project_registry`
2. `nbbs_bond_issuer`
3. `nbbs_oracle_consumer`
4. `nbbs_coupon_engine`
5. `nbbs_dex_router`
6. `nbbs_credit_retirement`

---

## 3. Step-by-Step Verification Procedure

### Option A: Hermetic Containerized Verification (Recommended)

Run the verification script:
```bash
bash scripts/reproducibility/docker-build.sh --verify
```

Or manually with Docker:
```bash
docker build -f Dockerfile.reproducible-build -t verdant-bond-reproducible-builder:v1 .
docker run --rm verdant-bond-reproducible-builder:v1 sha256sum -c checksums.sha256
```

### Option B: Local Verification

1. Install the pinned Rust toolchain:
   ```bash
   rustup show
   ```
2. Build all contract release WASM artifacts:
   ```bash
   cd contracts
   soroban contract build --release
   ```
3. Run the automated verification tests:
   ```bash
   cargo test -p nbbs-tests -- reproducible_build_test
   ```
4. Verify checksum manifest:
   ```bash
   bash scripts/reproducibility/wasm-checksums.sh --verify
   ```

---

## 4. Continuous Integration Gate

The repository enforces reproducibility checks on all pull requests and merges into `main` via [`.github/workflows/reproducible-builds.yml`](../.github/workflows/reproducible-builds.yml).
