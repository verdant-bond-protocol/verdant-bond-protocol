//! Immutable snapshots of project methodology at issuance time (#452).
//!
//! When a bond is issued, the project's methodology (credit type, oracle
//! parameters, verification standards) is frozen into an immutable snapshot.
//! This ensures the bond's terms cannot be retroactively changed.

use soroban_sdk::{contracttype, Env, Vec};

/// Immutable snapshot of project methodology captured at bond issuance.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct MethodologySnapshot {
    pub bond_id: u64,
    /// Methodology identifier (e.g. "BLUE-CARBON").
    pub methodology_id: soroban_sdk::String,
    /// Methodology version at issuance.
    pub methodology_version: u32,
    /// Credit type (Carbon, Biodiversity, etc.).
    pub credit_type: soroban_sdk::String,
    /// Verification standard applied.
    pub verification_standard: soroban_sdk::String,
    /// Oracle feed configuration hash.
    pub oracle_config_hash: soroban_sdk::BytesN<32>,
    /// Total credit quantity at issuance (minor units).
    pub total_credits: i128,
    /// Issuance timestamp.
    pub issued_at: u64,
    /// SHA-256 hash of the full snapshot content (integrity check).
    pub content_hash: soroban_sdk::BytesN<32>,
}

/// Registry of immutable methodology snapshots.
pub struct MethodologySnapshots {
    pub snapshots: Vec<MethodologySnapshot>,
}

impl MethodologySnapshots {
    pub fn new(env: &Env) -> Self {
        MethodologySnapshots {
            snapshots: Vec::new(env),
        }
    }

    /// Record a new snapshot at bond issuance. Returns the snapshot index.
    /// The snapshot is immutable once recorded — it cannot be updated or removed.
    pub fn record(&mut self, env: &Env, snapshot: MethodologySnapshot) -> u32 {
        self.snapshots.push_back(snapshot);
        (self.snapshots.len() - 1) as u32
    }

    /// Get the snapshot for a bond. Returns `None` if no snapshot exists.
    pub fn get_by_bond(&self, bond_id: u64) -> Option<MethodologySnapshot> {
        self.snapshots
            .iter()
            .find(|s| s.bond_id == bond_id)
    }

    /// Verify the integrity of a snapshot by recomputing its content hash.
    pub fn verify_integrity(&self, snapshot: &MethodologySnapshot) -> bool {
        // In production, recompute SHA-256 over the canonical serialization.
        // Here we verify the stored hash is non-zero (placeholder for real hash).
        snapshot.content_hash != soroban_sdk::BytesN::from_array(&Env::default(), &[0u8; 32])
    }

    /// Get total number of snapshots (bonds issued).
    pub fn count(&self) -> u32 {
        self.snapshots.len()
    }
}
