//! Jurisdiction rule versioning for existing investors (#450).
//!
//! Tracks which jurisdiction rule version each investor subscribed under.
//! When rules change, existing investors keep their original version until
//! an explicit migration. New investors get the latest version.

use soroban_sdk::{contracttype, Address, Env, Map};

/// A versioned jurisdiction rule set.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct JurisdictionRule {
    pub version: u32,
    pub jurisdiction: soroban_sdk::String,
    /// Max investment amount in minor units (0 = unlimited).
    pub max_investment: i128,
    /// Whether KYC is required.
    pub kyc_required: bool,
    /// Rule activation timestamp.
    pub activated_at: u64,
}

/// Tracks which rule version an investor is bound to.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct InvestorJurisdiction {
    pub investor: Address,
    pub rule_version: u32,
    pub locked_at: u64,
}

/// Registry of jurisdiction rules and investor bindings.
pub struct JurisdictionRegistry {
    /// All rule versions, keyed by version number.
    pub rules: Map<u32, JurisdictionRule>,
    /// Current active version for new investors.
    pub current_version: u32,
    /// Per-investor locked rule versions.
    pub investors: Map<Address, InvestorJurisdiction>,
}

impl JurisdictionRegistry {
    pub fn new(env: &Env) -> Self {
        JurisdictionRegistry {
            rules: Map::new(env),
            current_version: 0,
            investors: Map::new(env),
        }
    }

    /// Add a new rule version. Returns the version number.
    pub fn add_rule(
        &mut self,
        env: &Env,
        jurisdiction: soroban_sdk::String,
        max_investment: i128,
        kyc_required: bool,
    ) -> u32 {
        let version = self.current_version + 1;
        let rule = JurisdictionRule {
            version,
            jurisdiction,
            max_investment,
            kyc_required,
            activated_at: env.ledger().timestamp(),
        };
        self.rules.set(version, rule);
        self.current_version = version;
        version
    }

    /// Lock an investor to the current rule version at subscription time.
    pub fn lock_investor(&mut self, env: &Env, investor: &Address) {
        let binding = InvestorJurisdiction {
            investor: investor.clone(),
            rule_version: self.current_version,
            locked_at: env.ledger().timestamp(),
        };
        self.investors.set(investor.clone(), binding);
    }

    /// Get the rule version an investor is bound to.
    pub fn get_investor_version(&self, investor: &Address) -> Option<u32> {
        self.investors.get(investor.clone()).map(|b| b.rule_version)
    }

    /// Get the rule for an investor (their locked version, not the latest).
    pub fn get_investor_rule(&self, investor: &Address) -> Option<JurisdictionRule> {
        let version = self.get_investor_version(investor)?;
        self.rules.get(version)
    }

    /// Migrate an investor to the latest rule version. Requires explicit opt-in.
    pub fn migrate_investor(&mut self, env: &Env, investor: &Address) -> Option<u32> {
        let mut binding = self.investors.get(investor.clone())?;
        binding.rule_version = self.current_version;
        binding.locked_at = env.ledger().timestamp();
        self.investors.set(investor.clone(), binding.clone());
        Some(binding.rule_version)
    }
}
