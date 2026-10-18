//! Anti-replay protection for signed marketplace order updates (#448).
//!
//! Prevents replay of previously signed order update messages by tracking
//! used nonces and message hashes. Each signed order update must carry a
//! unique nonce and timestamp; replays are rejected.
//!
//! # Operational Edge Cases
//! - **Replay attack**: same signed message submitted twice → second rejected
//! - **Out-of-order nonces**: non-monotonic nonces accepted (no ordering
 *   requirement), but each nonce is used at most once
 * - **Expired timestamp**: messages older than the replay window are rejected
 * - **Retry after failure**: if the transaction fails on-chain, the nonce
 *   is NOT consumed, allowing retry with the same signed message

#![no_std]

use soroban_sdk::{contracttype, Address, BytesN, Env};

/// Maximum age of a signed order update message (seconds).
const REPLAY_WINDOW_SECS: u64 = 300; // 5 minutes

#[derive(Clone)]
#[contracttype]
pub enum ReplayKey {
    /// Tracks whether a specific nonce has been used for a given signer.
    NonceUsed(Address, u64),
    /// Tracks whether a message hash has been processed.
    MessageHashUsed(BytesN<32>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReplayError {
    /// Nonce already used — replay detected.
    NonceReused,
    /// Message hash already processed — replay detected.
    MessageReplayed,
    /// Message timestamp is outside the acceptable replay window.
    MessageExpired,
}

/// Check if a nonce has been used for a given signer.
pub fn is_nonce_used(env: &Env, signer: &Address, nonce: u64) -> bool {
    env.storage()
        .persistent()
        .has(&ReplayKey::NonceUsed(signer.clone(), nonce))
}

/// Check if a message hash has already been processed.
pub fn is_message_processed(env: &Env, msg_hash: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&ReplayKey::MessageHashUsed(msg_hash.clone()))
}

/// Validate and consume a nonce for anti-replay protection.
/// Returns Err if the nonce was already used.
pub fn consume_nonce(env: &Env, signer: &Address, nonce: u64) -> Result<(), ReplayError> {
    if is_nonce_used(env, signer, nonce) {
        return Err(ReplayError::NonceReused);
    }
    env.storage()
        .persistent()
        .set(&ReplayKey::NonceUsed(signer.clone(), nonce), &true);
    Ok(())
}

/// Validate and consume a message hash for anti-replay protection.
/// Returns Err if the message was already processed.
pub fn consume_message_hash(env: &Env, msg_hash: &BytesN<32>) -> Result<(), ReplayError> {
    if is_message_processed(env, msg_hash) {
        return Err(ReplayError::MessageReplayed);
    }
    env.storage()
        .persistent()
        .set(&ReplayKey::MessageHashUsed(msg_hash.clone()), &true);
    Ok(())
}

/// Validate that a message timestamp is within the replay window.
pub fn validate_timestamp(env: &Env, msg_timestamp: u64) -> Result<(), ReplayError> {
    let now = env.ledger().timestamp();
    if now > msg_timestamp && (now - msg_timestamp) > REPLAY_WINDOW_SECS {
        return Err(ReplayError::MessageExpired);
    }
    if msg_timestamp > now && (msg_timestamp - now) > REPLAY_WINDOW_SECS {
        return Err(ReplayError::MessageExpired);
    }
    Ok(())
}

/// Full anti-replay validation: timestamp + nonce + message hash.
pub fn validate_and_consume(
    env: &Env,
    signer: &Address,
    nonce: u64,
    msg_hash: &BytesN<32>,
    msg_timestamp: u64,
) -> Result<(), ReplayError> {
    validate_timestamp(env, msg_timestamp)?;
    consume_nonce(env, signer, nonce)?;
    consume_message_hash(env, msg_hash)?;
    Ok(())
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
    fn test_fresh_nonce_accepted() {
        let env = setup();
        let signer = Address::generate(&env);
        assert!(consume_nonce(&env, &signer, 1).is_ok());
    }

    #[test]
    fn test_replayed_nonce_rejected() {
        let env = setup();
        let signer = Address::generate(&env);
        assert!(consume_nonce(&env, &signer, 1).is_ok());
        assert_eq!(consume_nonce(&env, &signer, 1), Err(ReplayError::NonceReused));
    }

    #[test]
    fn test_different_nonces_accepted() {
        let env = setup();
        let signer = Address::generate(&env);
        assert!(consume_nonce(&env, &signer, 1).is_ok());
        assert!(consume_nonce(&env, &signer, 2).is_ok());
    }

    #[test]
    fn test_different_signers_same_nonce_accepted() {
        let env = setup();
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        assert!(consume_nonce(&env, &signer1, 1).is_ok());
        assert!(consume_nonce(&env, &signer2, 1).is_ok());
    }

    #[test]
    fn test_replayed_message_rejected() {
        let env = setup();
        let hash = BytesN::from_array(&env, &[1u8; 32]);
        assert!(consume_message_hash(&env, &hash).is_ok());
        assert_eq!(
            consume_message_hash(&env, &hash),
            Err(ReplayError::MessageReplayed)
        );
    }

    #[test]
    fn test_expired_timestamp_rejected() {
        let env = setup();
        env.ledger().with_mut(|li| li.timestamp = 1000);
        assert_eq!(
            validate_timestamp(&env, 1000 - REPLAY_WINDOW_SECS - 1),
            Err(ReplayError::MessageExpired)
        );
    }

    #[test]
    fn test_fresh_timestamp_accepted() {
        let env = setup();
        env.ledger().with_mut(|li| li.timestamp = 1000);
        assert!(validate_timestamp(&env, 1000).is_ok());
        assert!(validate_timestamp(&env, 999).is_ok());
    }

    #[test]
    fn test_full_validation_replay_rejected() {
        let env = setup();
        let signer = Address::generate(&env);
        let hash = BytesN::from_array(&env, &[1u8; 32]);
        env.ledger().with_mut(|li| li.timestamp = 1000);

        assert!(validate_and_consume(&env, &signer, 1, &hash, 1000).is_ok());
        // Replay same message
        assert!(validate_and_consume(&env, &signer, 1, &hash, 1000).is_err());
    }
}
