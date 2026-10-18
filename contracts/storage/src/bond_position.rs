//! # Storage migration fixtures for outstanding bond positions (#442)
//!
//! `storage_keys.json` (#159) snapshots the *key space* of every contract so a
//! schema change is visible as a before/after diff. It does not, however, pin
//! the *values* that make up a live, outstanding bond position — the data a
//! migration must carry forward without loss.
//!
//! This module produces deterministic fixtures for the storage entries that
//! constitute an outstanding `bond-issuer` position:
//!
//!   - `BondConfig(bond_id)`     → the bond's immutable terms.
//!   - `BondState(bond_id)`      → `total_subscribed`, status, creation time.
//!   - `HolderBalance(bond_id, holder)` → each holder's outstanding balance.
//!   - `RedemptionPool(bond_id)` → credits redeemed but not yet swept.
//!
//! Every fixture encodes both the `DataKey` and its stored value to XDR hex and
//! records the financial invariant
//!
//! ```text
//! sum(holder balances) + redemption pool == total_subscribed
//! ```
//!
//! so migration tooling and reviewers can assert that no outstanding position
//! was dropped, duplicated, or re-valued during a schema migration. The
//! fixtures are committed to `contracts/tests/fixtures/bond_positions.json` and
//! guarded against drift by `nbbs-tests::bond_positions`.
//!
//! Regenerate after an intentional schema change with:
//!
//! ```text
//! cargo test -p nbbs-tests --features storage-fixture-update regenerate_bond_position_fixture_file
//! ```

use alloc::{
    string::{String, ToString},
    vec::Vec,
};

use nbbs_bond_issuer::{BondState, DataKey as BondIssuerKey};
use nbbs_shared::{BondConfig, BondStatus, CreditType};
use serde::{Deserialize, Serialize};
use soroban_sdk::{testutils::Address as _, vec, Address, Env};

use super::{encode, make_project_id};

/// Schema version of the position fixtures. Bump when the *set of encoded
/// fields* changes so migration tooling can select the right decoder.
pub const BOND_POSITION_SCHEMA_VERSION: u32 = 1;

/// One holder's outstanding position inside a bond.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HolderPositionFixture {
    /// XDR hex of the `HolderBalance(bond_id, holder)` storage key.
    pub key_xdr_hex: String,
    /// Outstanding balance, in bond token minor units.
    pub balance: i128,
    /// XDR hex of the stored `i128` balance value.
    pub balance_xdr_hex: String,
}

/// A complete snapshot of one bond's outstanding positions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BondPositionFixture {
    /// Human-readable scenario name (e.g. `with-redemption-pool`).
    pub scenario: String,
    pub schema_version: u32,
    pub bond_id: u64,
    /// XDR hex of the stored `BondConfig` value.
    pub config_xdr_hex: String,
    /// XDR hex of the stored `BondState` value.
    pub state_xdr_hex: String,
    /// `BondState.total_subscribed`.
    pub total_subscribed: i128,
    /// Sum of every holder balance still outstanding.
    pub outstanding_balance: i128,
    /// Credits redeemed into the pool but not yet swept.
    pub redemption_pool: i128,
    /// XDR hex of the stored `RedemptionPool` `i128` value.
    pub redemption_pool_xdr_hex: String,
    pub holders: Vec<HolderPositionFixture>,
    /// True when `outstanding_balance + redemption_pool == total_subscribed`.
    pub invariant_holds: bool,
}

const TOTAL_SUPPLY: i128 = 1_000_000_000;

fn build_fixture(
    env: &Env,
    scenario: &str,
    bond_id: u64,
    balances: &[i128],
    redemption_pool: i128,
    status: BondStatus,
) -> BondPositionFixture {
    let mut holders = Vec::new();
    let mut outstanding: i128 = 0;
    for balance in balances.iter() {
        let holder: Address = Address::generate(env);
        let key: String = encode(env, BondIssuerKey::HolderBalance(bond_id, holder));
        holders.push(HolderPositionFixture {
            key_xdr_hex: key,
            balance: *balance,
            balance_xdr_hex: encode(env, *balance),
        });
        outstanding += *balance;
    }

    let total_subscribed = outstanding + redemption_pool;

    let config = BondConfig {
        project_id: make_project_id(env, bond_id as u8),
        face_value: 1000,
        coupon_schedule: vec![env, 1_000_000u64, 2_000_000u64],
        credit_type: CreditType::Carbon,
        maturity_date: 3_000_000,
        total_supply: TOTAL_SUPPLY,
        credit_vintage: 2024,
        serial_number_start: 1,
        serial_number_end: 1000,
    };
    let state = BondState {
        total_subscribed,
        status,
        created_at: 1_700_000_000,
    };

    BondPositionFixture {
        scenario: scenario.to_string(),
        schema_version: BOND_POSITION_SCHEMA_VERSION,
        bond_id,
        config_xdr_hex: encode(env, config),
        state_xdr_hex: encode(env, state),
        total_subscribed,
        outstanding_balance: outstanding,
        redemption_pool,
        redemption_pool_xdr_hex: encode(env, redemption_pool),
        holders,
        invariant_holds: total_subscribed == outstanding + redemption_pool,
    }
}

/// Deterministic set of outstanding-position fixtures covering the lifecycle of
/// a bond's holder positions.
pub fn generate_bond_position_fixtures(env: &Env) -> Vec<BondPositionFixture> {
    let mut fixtures = Vec::new();

    // Partially subscribed: two outstanding positions, nothing redeemed yet.
    fixtures.push(build_fixture(
        env,
        "partially-subscribed",
        1,
        &[400_000_000, 100_000_000],
        0,
        BondStatus::Active,
    ));

    // Matured: two positions with part of the supply moved into the pool.
    fixtures.push(build_fixture(
        env,
        "with-redemption-pool",
        2,
        &[250_000_000, 250_000_000],
        500_000_000,
        BondStatus::Matured,
    ));

    // Fully redeemed: no outstanding positions remain; the whole supply is in
    // the redemption pool pending a sweep.
    fixtures.push(build_fixture(
        env,
        "fully-redeemed",
        3,
        &[],
        TOTAL_SUPPLY,
        BondStatus::Matured,
    ));

    fixtures
}

/// Find a fixture by scenario name (for tests and migration tooling).
pub fn find_bond_position_fixture(
    fixtures: &[BondPositionFixture],
    scenario: &str,
) -> Option<BondPositionFixture> {
    fixtures
        .iter()
        .find(|fixture| fixture.scenario == scenario)
        .cloned()
}
