//! Credit retirement uniqueness checks across project registries (#444).
//!
//! Ensures that a credit retirement certificate hash is globally unique
//! across all project registries, preventing double-retirement of the same
//! credits through different registry entry points.
//!
//! # Operational Edge Cases
//! - **Duplicate certificate hash**: rejected at the contract level before
//!   any state mutation. Recovery: re-issue with a fresh hash.
//! - **Cross-registry collision**: a certificate retired in registry A cannot
//!   be retired again in registry B. Recovery: none — the retirement is final.
//! - **Retry after partial failure**: the nonce mechanism ensures each
//!   retirement attempt is idempotent per (holder, nonce) pair.

#![no_std]

use soroban_sdk::{contracttype, Address, BytesN, Env};

/// Stores a global set of retired certificate hashes to enforce uniqueness.
#[derive(Clone)]
#[contracttype]
pub enum UniquenessKey {
    /// Maps certificate hash → retirement record ID (0 = not retired).
    CertificateRetired(BytesN<32>),
    /// Global counter of unique retires.
    UniqueRetireCount,
}

/// Check whether a certificate hash has already been used for any retirement.
pub fn is_certificate_retired(env: &Env, cert_hash: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&UniquenessKey::CertificateRetired(cert_hash.clone()))
}

/// Mark a certificate hash as retired. Returns Err if already retired.
pub fn mark_certificate_retired(
    env: &Env,
    cert_hash: &BytesN<32>,
    record_id: u64,
) -> Result<(), UniquenessError> {
    if is_certificate_retired(env, cert_hash) {
        return Err(UniquenessError::DuplicateCertificate);
    }
    env.storage().persistent().set(
        &UniquenessKey::CertificateRetired(cert_hash.clone()),
        &record_id,
    );

    let count: u64 = env
        .storage()
        .persistent()
        .get(&UniquenessKey::UniqueRetireCount)
        .unwrap_or(0);
    env.storage()
        .persistent()
        .set(&UniquenessKey::UniqueRetireCount, &(count + 1));

    Ok(())
}

/// Get the total number of unique certificate retirements.
pub fn unique_retire_count(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&UniquenessKey::UniqueRetireCount)
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq)]
pub enum UniquenessError {
    DuplicateCertificate,
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{BytesN, Env};

    fn setup() -> Env {
        Env::default()
    }

    #[test]
    fn test_certificate_not_retired_initially() {
        let env = setup();
        let hash = BytesN::from_array(&env, &[1u8; 32]);
        assert!(!is_certificate_retired(&env, &hash));
    }

    #[test]
    fn test_mark_certificate_retired_succeeds() {
        let env = setup();
        let hash = BytesN::from_array(&env, &[1u8; 32]);
        assert!(mark_certificate_retired(&env, &hash, 1).is_ok());
        assert!(is_certificate_retired(&env, &hash));
    }

    #[test]
    fn test_duplicate_certificate_rejected() {
        let env = setup();
        let hash = BytesN::from_array(&env, &[1u8; 32]);
        assert!(mark_certificate_retired(&env, &hash, 1).is_ok());
        assert_eq!(
            mark_certificate_retired(&env, &hash, 2),
            Err(UniquenessError::DuplicateCertificate)
        );
    }

    #[test]
    fn test_different_certificates_allowed() {
        let env = setup();
        let hash1 = BytesN::from_array(&env, &[1u8; 32]);
        let hash2 = BytesN::from_array(&env, &[2u8; 32]);
        assert!(mark_certificate_retired(&env, &hash1, 1).is_ok());
        assert!(mark_certificate_retired(&env, &hash2, 2).is_ok());
    }

    #[test]
    fn test_unique_retire_count_tracks_correctly() {
        let env = setup();
        assert_eq!(unique_retire_count(&env), 0);

        let hash1 = BytesN::from_array(&env, &[1u8; 32]);
        let hash2 = BytesN::from_array(&env, &[2u8; 32]);
        mark_certificate_retired(&env, &hash1, 1).unwrap();
        mark_certificate_retired(&env, &hash2, 2).unwrap();

        assert_eq!(unique_retire_count(&env), 2);
    }
}
