//! # Storage schema fixtures (#159)
//!
//! Serializes every `DataKey` variant across all seven contracts to its XDR
//! hex form so the on-chain storage keys can be documented and guarded against
//! accidental schema drift. Changing any `DataKey` enum (adding/removing/
//! reordering variants or their payload types) changes the generated hex and
//! will fail `nbbs-tests` until the fixtures are regenerated with:
//!
//! ```text
//! cargo test -p nbbs-storage --features storage-fixture-update regenerate_storage_fixture_file
//! ```
//!
//! The hex is the on-the-wire `ScVal` XDR of each `DataKey` *value* (i.e. the
//! value the contracts pass to `env.storage().*.get/set`). The physical ledger
//! slot additionally hashes this value, but the XDR is the canonical,
//! human-auditable representation and the migration-compatibility anchor.
#![no_std]

extern crate alloc;

use alloc::{
    collections::BTreeMap,
    format,
    string::{String, ToString},
};

use nbbs_bond_issuer::DataKey as BondIssuerKey;
use nbbs_coupon_engine::DataKey as CouponEngineKey;
use nbbs_credit_retirement::DataKey as CreditRetirementKey;
use nbbs_dex_router::DataKey as DEXRouterKey;
use nbbs_governance::DataKey as GovernanceKey;
use nbbs_oracle_consumer::DataKey as OracleConsumerKey;
use nbbs_project_registry::DataKey as ProjectRegistryKey;
use nbbs_shared::CreditType;
use serde::{Deserialize, Serialize};
use soroban_sdk::{
    testutils::Address as _, xdr::ToXdr, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val,
};

/// A single documented storage key: the canonical Rust constructor expression
/// and the XDR hex serialization of its `DataKey` value.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
pub struct StorageKeyFixture {
    /// Canonical `DataKey` constructor expression (e.g. `PeriodInfo(1, 1)`).
    pub constructor: String,
    /// Hex-encoded XDR of the serialized `ScVal` for the key.
    pub xdr_hex: String,
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn encode<T: IntoVal<Env, Val>>(env: &Env, value: T) -> String {
    let bytes: Bytes = value.to_xdr(env);
    let mut collected = alloc::vec::Vec::with_capacity(bytes.len() as usize);
    for b in bytes.clone() {
        collected.push(b);
    }
    to_hex(&collected)
}

fn fx(constructor: &str, xdr_hex: String) -> StorageKeyFixture {
    StorageKeyFixture {
        constructor: constructor.to_string(),
        xdr_hex,
    }
}

fn make_project_id(env: &Env, value: u8) -> BytesN<32> {
    let mut arr = [0u8; 32];
    arr[31] = value;
    BytesN::from_array(env, &arr)
}

/// Generate the full fixture map for every contract's `DataKey` enum.
pub fn generate_storage_fixtures(
    env: &Env,
) -> BTreeMap<String, BTreeMap<String, StorageKeyFixture>> {
    let addr = Address::generate(env);

    let mut contracts: BTreeMap<String, BTreeMap<String, StorageKeyFixture>> = BTreeMap::new();

    let path = make_project_id(env, 1);

    let mut bond_issuer: BTreeMap<String, StorageKeyFixture> = BTreeMap::new();
    bond_issuer.insert(
        "Admin".to_string(),
        fx("Admin", encode(env, BondIssuerKey::Admin)),
    );
    bond_issuer.insert(
        "BondConfig(1)".to_string(),
        fx("BondConfig(1)", encode(env, BondIssuerKey::BondConfig(1))),
    );
    bond_issuer.insert(
        "BondState(1)".to_string(),
        fx("BondState(1)", encode(env, BondIssuerKey::BondState(1))),
    );
    bond_issuer.insert(
        "HolderBalance(1, addr)".to_string(),
        fx(
            "HolderBalance(1, addr)",
            encode(env, BondIssuerKey::HolderBalance(1, addr.clone())),
        ),
    );
    bond_issuer.insert(
        "RedemptionPool(1)".to_string(),
        fx(
            "RedemptionPool(1)",
            encode(env, BondIssuerKey::RedemptionPool(1)),
        ),
    );
    bond_issuer.insert(
        "BondCount".to_string(),
        fx("BondCount", encode(env, BondIssuerKey::BondCount)),
    );
    bond_issuer.insert(
        "Nonce(addr)".to_string(),
        fx(
            "Nonce(addr)",
            encode(env, BondIssuerKey::Nonce(addr.clone())),
        ),
    );
    bond_issuer.insert(
        "ProjectRegistry".to_string(),
        fx(
            "ProjectRegistry",
            encode(env, BondIssuerKey::ProjectRegistry),
        ),
    );
    contracts.insert("bond-issuer".to_string(), bond_issuer);

    let mut coupon_engine: BTreeMap<String, StorageKeyFixture> = BTreeMap::new();
    coupon_engine.insert(
        "Admin".to_string(),
        fx("Admin", encode(env, CouponEngineKey::Admin)),
    );
    coupon_engine.insert(
        "PerformanceHistory(1)".to_string(),
        fx(
            "PerformanceHistory(1)",
            encode(env, CouponEngineKey::PerformanceHistory(1)),
        ),
    );
    coupon_engine.insert(
        "PerformanceFlag(1)".to_string(),
        fx(
            "PerformanceFlag(1)",
            encode(env, CouponEngineKey::PerformanceFlag(1)),
        ),
    );
    coupon_engine.insert(
        "MinPerformanceAttestations".to_string(),
        fx(
            "MinPerformanceAttestations",
            encode(env, CouponEngineKey::MinPerformanceAttestations),
        ),
    );
    coupon_engine.insert(
        "MigrationWindow(1)".to_string(),
        fx(
            "MigrationWindow(1)",
            encode(env, CouponEngineKey::MigrationWindow(1)),
        ),
    );
    coupon_engine.insert(
        "PeriodInfo(1, 1)".to_string(),
        fx(
            "PeriodInfo(1, 1)",
            encode(env, CouponEngineKey::PeriodInfo(1, 1)),
        ),
    );
    coupon_engine.insert(
        "PeriodBatchCursor(1, 1)".to_string(),
        fx(
            "PeriodBatchCursor(1, 1)",
            encode(env, CouponEngineKey::PeriodBatchCursor(1, 1)),
        ),
    );
    coupon_engine.insert(
        "PeriodCount(1)".to_string(),
        fx(
            "PeriodCount(1)",
            encode(env, CouponEngineKey::PeriodCount(1)),
        ),
    );
    coupon_engine.insert(
        "AccruedCredits(1, addr)".to_string(),
        fx(
            "AccruedCredits(1, addr)",
            encode(env, CouponEngineKey::AccruedCredits(1, addr.clone())),
        ),
    );
    coupon_engine.insert(
        "AccruedCreditsByType(1, addr, Carbon)".to_string(),
        fx(
            "AccruedCreditsByType(1, addr, Carbon)",
            encode(
                env,
                CouponEngineKey::AccruedCreditsByType(1, addr.clone(), CreditType::Carbon),
            ),
        ),
    );
    coupon_engine.insert(
        "BondProject(1)".to_string(),
        fx(
            "BondProject(1)",
            encode(env, CouponEngineKey::BondProject(1)),
        ),
    );
    coupon_engine.insert(
        "BondCreditType(1)".to_string(),
        fx(
            "BondCreditType(1)",
            encode(env, CouponEngineKey::BondCreditType(1)),
        ),
    );
    coupon_engine.insert(
        "UndistributedTotal(1)".to_string(),
        fx(
            "UndistributedTotal(1)",
            encode(env, CouponEngineKey::UndistributedTotal(1)),
        ),
    );
    coupon_engine.insert(
        "Precision".to_string(),
        fx("Precision", encode(env, CouponEngineKey::Precision)),
    );
    coupon_engine.insert(
        "BondIssuerAddress".to_string(),
        fx(
            "BondIssuerAddress",
            encode(env, CouponEngineKey::BondIssuerAddress),
        ),
    );
    coupon_engine.insert(
        "OracleConsumerAddress".to_string(),
        fx(
            "OracleConsumerAddress",
            encode(env, CouponEngineKey::OracleConsumerAddress),
        ),
    );
    coupon_engine.insert(
        "Nonce(addr)".to_string(),
        fx(
            "Nonce(addr)",
            encode(env, CouponEngineKey::Nonce(addr.clone())),
        ),
    );
    coupon_engine.insert(
        "PeriodHolder(1, 1, addr, BlueCarbon)".to_string(),
        fx(
            "PeriodHolder(1, 1, addr, BlueCarbon)",
            encode(
                env,
                CouponEngineKey::PeriodHolder(1, 1, addr.clone(), CreditType::BlueCarbon),
            ),
        ),
    );
    contracts.insert("coupon-engine".to_string(), coupon_engine);

    let mut credit_retirement: BTreeMap<String, StorageKeyFixture> = BTreeMap::new();
    credit_retirement.insert(
        "Admin".to_string(),
        fx("Admin", encode(env, CreditRetirementKey::Admin)),
    );
    credit_retirement.insert(
        "Retirement(1)".to_string(),
        fx(
            "Retirement(1)",
            encode(env, CreditRetirementKey::Retirement(1)),
        ),
    );
    credit_retirement.insert(
        "RetirementCount".to_string(),
        fx(
            "RetirementCount",
            encode(env, CreditRetirementKey::RetirementCount),
        ),
    );
    credit_retirement.insert(
        "HolderRetirements(addr)".to_string(),
        fx(
            "HolderRetirements(addr)",
            encode(env, CreditRetirementKey::HolderRetirements(addr.clone())),
        ),
    );
    credit_retirement.insert(
        "RetiredCredits(addr)".to_string(),
        fx(
            "RetiredCredits(addr)",
            encode(env, CreditRetirementKey::RetiredCredits(addr.clone())),
        ),
    );
    credit_retirement.insert(
        "RetiredPerBond(1, addr)".to_string(),
        fx(
            "RetiredPerBond(1, addr)",
            encode(env, CreditRetirementKey::RetiredPerBond(1, addr.clone())),
        ),
    );
    credit_retirement.insert(
        "BondIssuerAddress".to_string(),
        fx(
            "BondIssuerAddress",
            encode(env, CreditRetirementKey::BondIssuerAddress),
        ),
    );
    credit_retirement.insert(
        "CouponEngineAddress".to_string(),
        fx(
            "CouponEngineAddress",
            encode(env, CreditRetirementKey::CouponEngineAddress),
        ),
    );
    credit_retirement.insert(
        "Nonce(addr)".to_string(),
        fx(
            "Nonce(addr)",
            encode(env, CreditRetirementKey::Nonce(addr.clone())),
        ),
    );
    contracts.insert("credit-retirement".to_string(), credit_retirement);

    let mut dex_router: BTreeMap<String, StorageKeyFixture> = BTreeMap::new();
    dex_router.insert(
        "Admin".to_string(),
        fx("Admin", encode(env, DEXRouterKey::Admin)),
    );
    dex_router.insert(
        "Order(1)".to_string(),
        fx("Order(1)", encode(env, DEXRouterKey::Order(1))),
    );
    dex_router.insert(
        "OrderCount".to_string(),
        fx("OrderCount", encode(env, DEXRouterKey::OrderCount)),
    );
    dex_router.insert(
        "SellerOrders(addr)".to_string(),
        fx(
            "SellerOrders(addr)",
            encode(env, DEXRouterKey::SellerOrders(addr.clone())),
        ),
    );
    dex_router.insert(
        "BondOrders(1)".to_string(),
        fx("BondOrders(1)", encode(env, DEXRouterKey::BondOrders(1))),
    );
    dex_router.insert(
        "BondIssuerAddress".to_string(),
        fx(
            "BondIssuerAddress",
            encode(env, DEXRouterKey::BondIssuerAddress),
        ),
    );
    dex_router.insert(
        "CouponEngineAddress".to_string(),
        fx(
            "CouponEngineAddress",
            encode(env, DEXRouterKey::CouponEngineAddress),
        ),
    );
    dex_router.insert(
        "Balance(COUPON, addr)".to_string(),
        fx(
            "Balance(COUPON, addr)",
            encode(
                env,
                DEXRouterKey::Balance(Symbol::new(env, "COUPON"), addr.clone()),
            ),
        ),
    );
    dex_router.insert(
        "BondEscrow(1, addr)".to_string(),
        fx(
            "BondEscrow(1, addr)",
            encode(env, DEXRouterKey::BondEscrow(1, addr.clone())),
        ),
    );
    dex_router.insert(
        "Nonce(addr)".to_string(),
        fx(
            "Nonce(addr)",
            encode(env, DEXRouterKey::Nonce(addr.clone())),
        ),
    );
    contracts.insert("dex-router".to_string(), dex_router);

    let mut governance: BTreeMap<String, StorageKeyFixture> = BTreeMap::new();
    governance.insert(
        "Signers".to_string(),
        fx("Signers", encode(env, GovernanceKey::Signers)),
    );
    governance.insert(
        "Threshold".to_string(),
        fx("Threshold", encode(env, GovernanceKey::Threshold)),
    );
    governance.insert(
        "TimelockSeconds".to_string(),
        fx(
            "TimelockSeconds",
            encode(env, GovernanceKey::TimelockSeconds),
        ),
    );
    governance.insert(
        "Proposal(1)".to_string(),
        fx("Proposal(1)", encode(env, GovernanceKey::Proposal(1))),
    );
    governance.insert(
        "ProposalCount".to_string(),
        fx("ProposalCount", encode(env, GovernanceKey::ProposalCount)),
    );
    governance.insert(
        "Vote(1, addr)".to_string(),
        fx(
            "Vote(1, addr)",
            encode(env, GovernanceKey::Vote(1, addr.clone())),
        ),
    );
    governance.insert(
        "Nonce(addr)".to_string(),
        fx(
            "Nonce(addr)",
            encode(env, GovernanceKey::Nonce(addr.clone())),
        ),
    );
    governance.insert(
        "ExecutionNonce(addr)".to_string(),
        fx(
            "ExecutionNonce(addr)",
            encode(env, GovernanceKey::ExecutionNonce(addr.clone())),
        ),
    );
    governance.insert(
        "AllowList(addr, COUPON)".to_string(),
        fx(
            "AllowList(addr, COUPON)",
            encode(
                env,
                GovernanceKey::AllowList(addr.clone(), Symbol::new(env, "COUPON")),
            ),
        ),
    );
    contracts.insert("governance".to_string(), governance);

    let mut oracle_consumer: BTreeMap<String, StorageKeyFixture> = BTreeMap::new();
    oracle_consumer.insert(
        "Admin".to_string(),
        fx("Admin", encode(env, OracleConsumerKey::Admin)),
    );
    oracle_consumer.insert(
        "Provider(addr)".to_string(),
        fx(
            "Provider(addr)",
            encode(env, OracleConsumerKey::Provider(addr.clone())),
        ),
    );
    oracle_consumer.insert(
        "ProviderList".to_string(),
        fx("ProviderList", encode(env, OracleConsumerKey::ProviderList)),
    );
    oracle_consumer.insert(
        "Report(1)".to_string(),
        fx("Report(1)", encode(env, OracleConsumerKey::Report(1))),
    );
    oracle_consumer.insert(
        "ReportCount".to_string(),
        fx("ReportCount", encode(env, OracleConsumerKey::ReportCount)),
    );
    oracle_consumer.insert(
        "ProjectReports(path)".to_string(),
        fx(
            "ProjectReports(path)",
            encode(env, OracleConsumerKey::ProjectReports(path.clone())),
        ),
    );
    oracle_consumer.insert(
        "Challenge(1)".to_string(),
        fx("Challenge(1)", encode(env, OracleConsumerKey::Challenge(1))),
    );
    oracle_consumer.insert(
        "ReportVerifiers(1)".to_string(),
        fx(
            "ReportVerifiers(1)",
            encode(env, OracleConsumerKey::ReportVerifiers(1)),
        ),
    );
    oracle_consumer.insert(
        "VerificationCount(1)".to_string(),
        fx(
            "VerificationCount(1)",
            encode(env, OracleConsumerKey::VerificationCount(1)),
        ),
    );
    oracle_consumer.insert(
        "SignatureThreshold".to_string(),
        fx(
            "SignatureThreshold",
            encode(env, OracleConsumerKey::SignatureThreshold),
        ),
    );
    oracle_consumer.insert(
        "MinimumVerifierStake".to_string(),
        fx(
            "MinimumVerifierStake",
            encode(env, OracleConsumerKey::MinimumVerifierStake),
        ),
    );
    oracle_consumer.insert(
        "ChallengeWindow".to_string(),
        fx(
            "ChallengeWindow",
            encode(env, OracleConsumerKey::ChallengeWindow),
        ),
    );
    oracle_consumer.insert(
        "Nonce(addr)".to_string(),
        fx(
            "Nonce(addr)",
            encode(env, OracleConsumerKey::Nonce(addr.clone())),
        ),
    );
    oracle_consumer.insert(
        "ProviderReportCount(addr)".to_string(),
        fx(
            "ProviderReportCount(addr)",
            encode(env, OracleConsumerKey::ProviderReportCount(addr.clone())),
        ),
    );
    oracle_consumer.insert(
        "ProviderChallenges(addr)".to_string(),
        fx(
            "ProviderChallenges(addr)",
            encode(env, OracleConsumerKey::ProviderChallenges(addr.clone())),
        ),
    );
    oracle_consumer.insert(
        "SlashHistory(addr)".to_string(),
        fx(
            "SlashHistory(addr)",
            encode(env, OracleConsumerKey::SlashHistory(addr.clone())),
        ),
    );
    contracts.insert("oracle-consumer".to_string(), oracle_consumer);

    let mut project_registry: BTreeMap<String, StorageKeyFixture> = BTreeMap::new();
    project_registry.insert(
        "Admin".to_string(),
        fx("Admin", encode(env, ProjectRegistryKey::Admin)),
    );
    project_registry.insert(
        "Project(path)".to_string(),
        fx(
            "Project(BytesN<32>(..1))",
            encode(env, ProjectRegistryKey::Project(path.clone())),
        ),
    );
    project_registry.insert(
        "ProjectCount".to_string(),
        fx(
            "ProjectCount",
            encode(env, ProjectRegistryKey::ProjectCount),
        ),
    );
    project_registry.insert(
        "ProjectId(1)".to_string(),
        fx(
            "ProjectId(1)",
            encode(env, ProjectRegistryKey::ProjectId(1)),
        ),
    );
    project_registry.insert(
        "Nonce(addr)".to_string(),
        fx(
            "Nonce(addr)",
            encode(env, ProjectRegistryKey::Nonce(addr.clone())),
        ),
    );
    project_registry.insert(
        "OwnerProjects(addr)".to_string(),
        fx(
            "OwnerProjects(addr)",
            encode(env, ProjectRegistryKey::OwnerProjects(addr.clone())),
        ),
    );
    project_registry.insert(
        "ProjectDocuments(1)".to_string(),
        fx(
            "ProjectDocuments(1)",
            encode(env, ProjectRegistryKey::ProjectDocuments(1)),
        ),
    );
    contracts.insert("project-registry".to_string(), project_registry);

    contracts
}
