# Deterministic build container for Verdant Bond Protocol Soroban contracts
# This image ensures reproducible WASM builds across different machines and CI runs.
#
# Build: docker build -t verdant-bond-contracts:26.0.1-1.87.0 -f contracts/Dockerfile contracts/
# Run:   docker run --rm -v $(pwd)/contracts:/workspace verdant-bond-contracts:26.0.1-1.87.0

FROM rust:1.87.0-slim-bookworm AS builder

# Pin Soroban CLI version to match SDK
ARG SOROBAN_CLI_VERSION=26.0.1

# Install system dependencies for Soroban builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install pinned Soroban CLI
RUN cargo install --locked soroban-cli --version ${SOROBAN_CLI_VERSION} \
    && soroban --version

# Create workspace directory
WORKDIR /workspace

# Copy Cargo workspace files first for dependency caching
COPY contracts/Cargo.toml contracts/Cargo.lock ./
COPY contracts/shared/Cargo.toml ./shared/
COPY contracts/bond-issuer/Cargo.toml ./bond-issuer/
COPY contracts/coupon-engine/Cargo.toml ./coupon-engine/
COPY contracts/oracle-consumer/Cargo.toml ./oracle-consumer/
COPY contracts/dex-router/Cargo.toml ./dex-router/
COPY contracts/project-registry/Cargo.toml ./project-registry/
COPY contracts/credit-retirement/Cargo.toml ./credit-retirement/
COPY contracts/governance/Cargo.toml ./governance/
COPY contracts/storage/Cargo.toml ./storage/
COPY contracts/tests/Cargo.toml ./tests/

# Pre-fetch dependencies (this layer is cached unless Cargo.toml/Cargo.lock changes)
RUN mkdir -p shared/src bond-issuer/src coupon-engine/src oracle-consumer/src \
    dex-router/src project-registry/src credit-retirement/src governance/src \
    storage/src tests/src \
    && echo 'fn main() {}' > shared/src/lib.rs \
    && echo 'fn main() {}' > bond-issuer/src/lib.rs \
    && echo 'fn main() {}' > coupon-engine/src/lib.rs \
    && echo 'fn main() {}' > oracle-consumer/src/lib.rs \
    && echo 'fn main() {}' > dex-router/src/lib.rs \
    && echo 'fn main() {}' > project-registry/src/lib.rs \
    && echo 'fn main() {}' > credit-retirement/src/lib.rs \
    && echo 'fn main() {}' > governance/src/lib.rs \
    && echo 'fn main() {}' > storage/src/lib.rs \
    && echo 'fn main() {}' > tests/src/lib.rs \
    && cargo fetch --locked \
    && rm -rf shared/src bond-issuer/src coupon-engine/src oracle-consumer/src \
    dex-router/src project-registry/src credit-retirement/src governance/src \
    storage/src tests/src

# Copy actual source code
COPY contracts/ .

# Build all contracts in release mode with deterministic settings
# CARGO_BUILD_RUSTC_FLAGS ensures no debug info or path info leaks into binary
ENV CARGO_BUILD_RUSTC_FLAGS="-Zremap-cwd-prefix=. -Cdebuginfo=0 -Cstrip=symbols"

RUN soroban contract build --release --locked

# Verify reproducibility by generating checksums
RUN find target/wasm32-unknown-unknown/release -name "nbbs_*.wasm" -exec sha256sum {} \; | sort > checksums.sha256

# Final minimal image with just the artifacts
FROM scratch AS artifacts
COPY --from=builder /workspace/target/wasm32-unknown-unknown/release/nbbs_*.wasm /
COPY --from=builder /workspace/checksums.sha256 /