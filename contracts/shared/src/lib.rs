#![no_std]
mod errors;
mod types;
pub use errors::*;
pub use types::*;

/// Issue #188 — versioned-interface convention for the contract suite.
///
/// Every contract exposes `schema_version() -> u32`. A deployment's version
/// means: "storage keys and callable interface are compatible with the
/// semantics documented for this version". Contracts may only interoperate
/// (cross-call) when their schema versions are known to each other; bump a
/// contract's `SCHEMA_VERSION` when its storage layout or callable interface
/// changes in a breaking way, and follow docs/upgrade-migrations.md.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;
