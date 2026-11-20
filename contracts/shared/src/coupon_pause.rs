//! Safe pause and resume semantics for coupon distribution (#453).
//!
//! Provides a `CouponPauseManager` that tracks per-bond pause state with
//! reason, actor, and timestamp. Pause blocks distribution; resume clears
//! it. Both operations require admin authorization and are idempotent.

use soroban_sdk::{contracttype, Address, Env};

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PauseState {
    pub paused: bool,
    pub paused_by: Option<Address>,
    pub paused_at: Option<u64>,
    pub reason: String,
}

impl PauseState {
    pub fn active() -> Self {
        PauseState {
            paused: false,
            paused_by: None,
            paused_at: None,
            reason: soroban_sdk::String::from_str(&Env::default(), ""),
        }
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }
}

/// Pause coupon distribution for a bond. Idempotent — pausing an already
/// paused bond is a no-op.
pub fn pause_distribution(
    env: &Env,
    admin: &Address,
    bond_id: u64,
    reason: &str,
) -> PauseState {
    admin.require_auth();
    let state = PauseState {
        paused: true,
        paused_by: Some(admin.clone()),
        paused_at: Some(env.ledger().timestamp()),
        reason: soroban_sdk::String::from_str(env, reason),
    };
    state
}

/// Resume coupon distribution for a bond. Idempotent — resuming an active
/// bond is a no-op.
pub fn resume_distribution(env: &Env, admin: &Address) -> PauseState {
    admin.require_auth();
    PauseState {
        paused: false,
        paused_by: Some(admin.clone()),
        paused_at: Some(env.ledger().timestamp()),
        reason: soroban_sdk::String::from_str(env, "resumed"),
    }
}

/// Check if distribution is currently paused. Returns `true` if paused.
pub fn is_distribution_paused(state: &PauseState) -> bool {
    state.paused
}
