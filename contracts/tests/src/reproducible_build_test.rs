#![cfg(test)]

use std::fs;
use std::path::PathBuf;

fn contract_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.parent().unwrap().to_path_buf()
}

#[test]
fn test_reproducible_toolchain_pinned() {
    let root = contract_root();
    let toolchain_file = root.join("rust-toolchain.toml");
    assert!(
        toolchain_file.exists(),
        "rust-toolchain.toml must exist in contracts root to guarantee deterministic toolchain"
    );

    let content = fs::read_to_string(&toolchain_file).expect("read rust-toolchain.toml");
    assert!(
        content.contains("wasm32-unknown-unknown"),
        "toolchain must pin wasm32-unknown-unknown target"
    );
    assert!(
        content.contains("channel"),
        "toolchain must pin explicit channel version"
    );
}

#[test]
fn test_cargo_lock_committed_and_in_sync() {
    let root = contract_root();
    let lock_file = root.join("Cargo.lock");
    assert!(
        lock_file.exists(),
        "contracts/Cargo.lock must be committed for dependency graph immutability"
    );

    let content = fs::read_to_string(&lock_file).expect("read Cargo.lock");
    assert!(
        content.contains("nbbs-bond-issuer"),
        "Cargo.lock must contain workspace packages"
    );
    assert!(
        content.contains("soroban-sdk"),
        "Cargo.lock must pin soroban-sdk version"
    );
}

#[test]
fn test_checksum_manifest_format_and_coverage() {
    let root = contract_root();
    let manifest_file = root.join("checksums.sha256");
    
    // If manifest exists, verify all 6 core protocol contracts are defined
    if manifest_file.exists() {
        let content = fs::read_to_string(&manifest_file).expect("read checksums.sha256");
        let required_contracts = [
            "nbbs_project_registry",
            "nbbs_bond_issuer",
            "nbbs_oracle_consumer",
            "nbbs_coupon_engine",
            "nbbs_dex_router",
            "nbbs_credit_retirement",
        ];

        for contract in required_contracts {
            assert!(
                content.contains(contract),
                "checksum manifest missing checksum entry for {}",
                contract
            );
        }

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            assert_eq!(
                parts.len(),
                2,
                "Each checksum entry must be format '<sha256> <filename>'"
            );
            assert_eq!(
                parts[0].len(),
                64,
                "SHA-256 hash must be 64 characters hex"
            );
            assert!(
                parts[0].chars().all(|c| c.is_ascii_hexdigit()),
                "SHA-256 hash must only contain hexadecimal characters"
            );
        }
    }
}
