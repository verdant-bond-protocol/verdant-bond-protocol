// Issue #465: Implement transaction intent binding to network and contract deployment
// Binds transaction intents to specific network and contract instances to prevent replay attacks

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String, BytesN};

/// Transaction intent structure
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionIntent {
    /// Network identifier (mainnet, testnet, futurenet)
    pub network_id: String,
    /// Contract address this intent is bound to
    pub contract_address: Address,
    /// Deployment timestamp of the contract
    pub deployment_timestamp: u64,
    /// Intent action (issue, transfer, redeem, etc.)
    pub action: String,
    /// Intent parameters (action-specific)
    pub params: BytesN<32>,
    /// Expiration timestamp
    pub expires_at: u64,
    /// Nonce to prevent replay
    pub nonce: u64,
}

/// Intent verification result
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IntentVerificationResult {
    Valid,
    InvalidNetwork,
    InvalidContract,
    Expired,
    AlreadyUsed,
    InvalidSignature,
}

/// Intent binding configuration
#[contracttype]
#[derive(Clone, Debug)]
pub struct IntentConfig {
    /// Maximum intent lifetime in seconds
    pub max_lifetime_secs: u64,
    /// Enable strict network binding
    pub strict_network_binding: bool,
    /// Enable deployment timestamp validation
    pub validate_deployment: bool,
}

const CONFIG: soroban_sdk::Symbol = symbol_short!("CONFIG");
const USED_NONCES: soroban_sdk::Symbol = symbol_short!("NONCES");
const DEPLOYMENT_TS: soroban_sdk::Symbol = symbol_short!("DEPLOY_TS");

#[contract]
pub struct TransactionIntentContract;

#[contractimpl]
impl TransactionIntentContract {
    /// Initialize the contract with deployment metadata
    pub fn initialize(
        env: Env,
        network_id: String,
        deployment_timestamp: u64,
        config: IntentConfig,
    ) {
        // Store deployment metadata
        env.storage().instance().set(&DEPLOYMENT_TS, &deployment_timestamp);
        env.storage().instance().set(&CONFIG, &config);
        env.storage().instance().set(&symbol_short!("NETWORK"), &network_id);
    }

    /// Create a transaction intent bound to current network and contract
    pub fn create_intent(
        env: Env,
        action: String,
        params: BytesN<32>,
        expires_at: u64,
        nonce: u64,
    ) -> TransactionIntent {
        let network_id: String = env
            .storage()
            .instance()
            .get(&symbol_short!("NETWORK"))
            .unwrap();
        
        let deployment_timestamp: u64 = env
            .storage()
            .instance()
            .get(&DEPLOYMENT_TS)
            .unwrap();

        let config: IntentConfig = env.storage().instance().get(&CONFIG).unwrap();

        // Validate expiration doesn't exceed max lifetime
        let current_time = env.ledger().timestamp();
        let max_expiration = current_time + config.max_lifetime_secs;
        
        let validated_expires_at = if expires_at > max_expiration {
            max_expiration
        } else {
            expires_at
        };

        TransactionIntent {
            network_id,
            contract_address: env.current_contract_address(),
            deployment_timestamp,
            action,
            params,
            expires_at: validated_expires_at,
            nonce,
        }
    }

    /// Verify and consume a transaction intent
    pub fn verify_intent(
        env: Env,
        intent: TransactionIntent,
        signer: Address,
    ) -> IntentVerificationResult {
        // Verify network binding
        let stored_network: String = env
            .storage()
            .instance()
            .get(&symbol_short!("NETWORK"))
            .unwrap();
        
        let config: IntentConfig = env.storage().instance().get(&CONFIG).unwrap();

        if config.strict_network_binding && intent.network_id != stored_network {
            return IntentVerificationResult::InvalidNetwork;
        }

        // Verify contract address binding
        if intent.contract_address != env.current_contract_address() {
            return IntentVerificationResult::InvalidContract;
        }

        // Verify deployment timestamp if enabled
        if config.validate_deployment {
            let stored_deployment: u64 = env
                .storage()
                .instance()
                .get(&DEPLOYMENT_TS)
                .unwrap();
            
            if intent.deployment_timestamp != stored_deployment {
                return IntentVerificationResult::InvalidContract;
            }
        }

        // Check expiration
        let current_time = env.ledger().timestamp();
        if current_time > intent.expires_at {
            return IntentVerificationResult::Expired;
        }

        // Check nonce hasn't been used
        let nonce_key = (signer.clone(), intent.nonce);
        if env
            .storage()
            .persistent()
            .has(&nonce_key)
        {
            return IntentVerificationResult::AlreadyUsed;
        }

        // Mark nonce as used
        env.storage().persistent().set(&nonce_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&nonce_key, 100, 100);

        IntentVerificationResult::Valid
    }

    /// Check if intent is valid without consuming it
    pub fn check_intent(env: Env, intent: TransactionIntent, signer: Address) -> bool {
        // Network check
        let stored_network: String = env
            .storage()
            .instance()
            .get(&symbol_short!("NETWORK"))
            .unwrap();
        
        let config: IntentConfig = env.storage().instance().get(&CONFIG).unwrap();

        if config.strict_network_binding && intent.network_id != stored_network {
            return false;
        }

        // Contract address check
        if intent.contract_address != env.current_contract_address() {
            return false;
        }

        // Deployment timestamp check
        if config.validate_deployment {
            let stored_deployment: u64 = env
                .storage()
                .instance()
                .get(&DEPLOYMENT_TS)
                .unwrap();
            
            if intent.deployment_timestamp != stored_deployment {
                return false;
            }
        }

        // Expiration check
        let current_time = env.ledger().timestamp();
        if current_time > intent.expires_at {
            return false;
        }

        // Nonce check
        let nonce_key = (signer, intent.nonce);
        if env.storage().persistent().has(&nonce_key) {
            return false;
        }

        true
    }

    /// Get contract deployment metadata
    pub fn get_deployment_metadata(env: Env) -> (String, Address, u64) {
        let network_id: String = env
            .storage()
            .instance()
            .get(&symbol_short!("NETWORK"))
            .unwrap();
        
        let deployment_timestamp: u64 = env
            .storage()
            .instance()
            .get(&DEPLOYMENT_TS)
            .unwrap();

        (network_id, env.current_contract_address(), deployment_timestamp)
    }

    /// Update intent configuration (admin only)
    pub fn update_config(env: Env, admin: Address, new_config: IntentConfig) {
        admin.require_auth();
        env.storage().instance().set(&CONFIG, &new_config);
    }

    /// Get current configuration
    pub fn get_config(env: Env) -> IntentConfig {
        env.storage().instance().get(&CONFIG).unwrap()
    }

    /// Check if nonce has been used
    pub fn is_nonce_used(env: Env, signer: Address, nonce: u64) -> bool {
        let nonce_key = (signer, nonce);
        env.storage().persistent().has(&nonce_key)
    }

    /// Cleanup expired nonces (maintenance function)
    pub fn cleanup_expired_nonces(env: Env, signer: Address, nonces: soroban_sdk::Vec<u64>) {
        for nonce in nonces.iter() {
            let nonce_key = (signer.clone(), nonce);
            if env.storage().persistent().has(&nonce_key) {
                env.storage().persistent().remove(&nonce_key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    #[test]
    fn test_intent_creation_and_verification() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TransactionIntentContract);
        let client = TransactionIntentContractClient::new(&env, &contract_id);

        let network_id = String::from_str(&env, "testnet");
        let config = IntentConfig {
            max_lifetime_secs: 3600,
            strict_network_binding: true,
            validate_deployment: true,
        };

        client.initialize(&network_id, &1000, &config);

        // Create intent
        let action = String::from_str(&env, "transfer");
        let params = BytesN::from_array(&env, &[0u8; 32]);
        let expires_at = env.ledger().timestamp() + 1800;
        let nonce = 1;

        let intent = client.create_intent(&action, &params, &expires_at, &nonce);

        // Verify intent
        let signer = Address::generate(&env);
        let result = client.verify_intent(&intent, &signer);
        assert_eq!(result, IntentVerificationResult::Valid);

        // Verify nonce is now used
        assert!(client.is_nonce_used(&signer, &nonce));

        // Try to reuse same intent - should fail
        let result2 = client.verify_intent(&intent, &signer);
        assert_eq!(result2, IntentVerificationResult::AlreadyUsed);
    }

    #[test]
    fn test_network_mismatch() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TransactionIntentContract);
        let client = TransactionIntentContractClient::new(&env, &contract_id);

        let network_id = String::from_str(&env, "mainnet");
        let config = IntentConfig {
            max_lifetime_secs: 3600,
            strict_network_binding: true,
            validate_deployment: false,
        };

        client.initialize(&network_id, &1000, &config);

        // Create intent with different network
        let mut intent = client.create_intent(
            &String::from_str(&env, "transfer"),
            &BytesN::from_array(&env, &[0u8; 32]),
            &(env.ledger().timestamp() + 1800),
            &1,
        );
        
        intent.network_id = String::from_str(&env, "testnet");

        let signer = Address::generate(&env);
        let result = client.verify_intent(&intent, &signer);
        assert_eq!(result, IntentVerificationResult::InvalidNetwork);
    }

    #[test]
    fn test_expired_intent() {
        let env = Env::default();
        let contract_id = env.register_contract(None, TransactionIntentContract);
        let client = TransactionIntentContractClient::new(&env, &contract_id);

        let config = IntentConfig {
            max_lifetime_secs: 3600,
            strict_network_binding: false,
            validate_deployment: false,
        };

        client.initialize(&String::from_str(&env, "testnet"), &1000, &config);

        // Create intent with past expiration
        let intent = client.create_intent(
            &String::from_str(&env, "transfer"),
            &BytesN::from_array(&env, &[0u8; 32]),
            &(env.ledger().timestamp() - 100),
            &1,
        );

        let signer = Address::generate(&env);
        let result = client.verify_intent(&intent, &signer);
        assert_eq!(result, IntentVerificationResult::Expired);
    }
}
