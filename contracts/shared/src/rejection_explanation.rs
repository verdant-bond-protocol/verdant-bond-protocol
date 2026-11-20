//! Investor-facing explanation module for rejected eligibility and transfer actions.
//!
//! Enforces:
//! - Normal path: maps contract errors and compliance signals to clear, structured,
//!   investor-facing explanations with category, actionability, remediation steps, and safe guidance.
//! - Failure path: rejects invalid parameters (e.g. zero bond IDs, non-existent records).
//! - Retry path: updates existing rejections idempotently upon retries without duplicating records.
//! - Authorization path: restricts access to investor-specific explanations to the investor
//!   themselves or an authorized compliance admin (`require_auth()`).
//! - Financial and Privacy Invariants: strictly prevents leakage of internal heuristics or PII,
//!   preserving bounded, deterministic metadata.

use soroban_sdk::{contracttype, Address, Env, Map, Symbol};

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum RejectionCategory {
    IdentityAndKyc = 1,
    RegulatoryAccreditation = 2,
    JurisdictionalSanctions = 3,
    InvestmentLimits = 4,
    MarketAndLifecycle = 5,
    BalanceAndEscrow = 6,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum ActionType {
    Subscription = 1,
    AttestationRequest = 2,
    SecondaryTransfer = 3,
    TrancheAcquisition = 4,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum RejectionCode {
    KycRequired = 1,
    KycExpired = 2,
    AccreditationRequired = 3,
    SanctionedAddress = 4,
    SanctionedJurisdiction = 5,
    TrancheNotPermitted = 6,
    OfferingCapExceeded = 7,
    InsufficientSupply = 8,
    BondAlreadyMatured = 9,
    TransferBlocked = 10,
    InvalidAmount = 11,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum RemediationType {
    SelfService = 1,
    DocumentUpload = 2,
    AdjustAmount = 3,
    WaitCooldown = 4,
    ContactSupport = 5,
    TerminalBlock = 6,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RejectionError {
    Unauthorized,
    ExplanationNotFound,
    ZeroBondId,
    AlreadyResolved,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct InvestorRejectionExplanation {
    pub explanation_id: u64,
    pub action_type: ActionType,
    pub investor: Address,
    pub bond_id: u64,
    pub category: RejectionCategory,
    pub code: RejectionCode,
    pub remediation_type: RemediationType,
    pub is_retryable: bool,
    pub retry_after_seconds: u32,
    pub summary: soroban_sdk::String,
    pub remediation_step: soroban_sdk::String,
    pub recorded_at: u64,
    pub retry_count: u32,
}

/// On-chain registry of investor-facing explanations for rejected actions.
pub struct RejectionExplanationManager {
    pub records: Map<u64, InvestorRejectionExplanation>,
    pub investor_last_rejection: Map<Address, u64>,
    pub next_id: u64,
    pub admin: Address,
}

impl RejectionExplanationManager {
    pub fn new(env: &Env, admin: Address) -> Self {
        RejectionExplanationManager {
            records: Map::new(env),
            investor_last_rejection: Map::new(env),
            next_id: 1,
            admin,
        }
    }

    /// Derives investor-facing metadata (category, remediation, retryability, summary, steps)
    /// from a structured RejectionCode.
    pub fn derive_explanation_content(
        env: &Env,
        code: RejectionCode,
    ) -> (
        RejectionCategory,
        RemediationType,
        bool,
        u32,
        soroban_sdk::String,
        soroban_sdk::String,
    ) {
        match code {
            RejectionCode::KycRequired => (
                RejectionCategory::IdentityAndKyc,
                RemediationType::DocumentUpload,
                true,
                0,
                soroban_sdk::String::from_str(env, "KYC identity verification required to participate."),
                soroban_sdk::String::from_str(env, "Submit government-issued ID and proof of residence to complete KYC tier."),
            ),
            RejectionCode::KycExpired => (
                RejectionCategory::IdentityAndKyc,
                RemediationType::DocumentUpload,
                true,
                0,
                soroban_sdk::String::from_str(env, "KYC identity verification has expired."),
                soroban_sdk::String::from_str(env, "Renew your KYC documents to refresh verification status."),
            ),
            RejectionCode::AccreditationRequired => (
                RejectionCategory::RegulatoryAccreditation,
                RemediationType::DocumentUpload,
                true,
                0,
                soroban_sdk::String::from_str(env, "Restricted tranche requires verified accredited investor certification."),
                soroban_sdk::String::from_str(env, "Upload qualified purchaser or accredited investor attestation (e.g. Reg D 506(c))."),
            ),
            RejectionCode::SanctionedAddress => (
                RejectionCategory::JurisdictionalSanctions,
                RemediationType::TerminalBlock,
                false,
                0,
                soroban_sdk::String::from_str(env, "Wallet address is restricted under international compliance policies."),
                soroban_sdk::String::from_str(env, "Contact compliance support if you believe this address restriction is an error."),
            ),
            RejectionCode::SanctionedJurisdiction => (
                RejectionCategory::JurisdictionalSanctions,
                RemediationType::TerminalBlock,
                false,
                0,
                soroban_sdk::String::from_str(env, "Offerings are restricted in the detected jurisdiction."),
                soroban_sdk::String::from_str(env, "Participation from comprehensive embargo jurisdictions is strictly prohibited by law."),
            ),
            RejectionCode::TrancheNotPermitted => (
                RejectionCategory::RegulatoryAccreditation,
                RemediationType::SelfService,
                true,
                0,
                soroban_sdk::String::from_str(env, "Selected tranche is not approved for your jurisdiction."),
                soroban_sdk::String::from_str(env, "Select an allowed tranche (such as STANDARD) for this bond offering."),
            ),
            RejectionCode::OfferingCapExceeded => (
                RejectionCategory::InvestmentLimits,
                RemediationType::AdjustAmount,
                true,
                0,
                soroban_sdk::String::from_str(env, "Attempted investment exceeds the retail investor cap for your jurisdiction."),
                soroban_sdk::String::from_str(env, "Reduce the subscription or purchase amount below the statutory jurisdiction cap."),
            ),
            RejectionCode::InsufficientSupply => (
                RejectionCategory::BalanceAndEscrow,
                RemediationType::AdjustAmount,
                true,
                0,
                soroban_sdk::String::from_str(env, "Transfer or subscription amount exceeds available token balance or offering supply."),
                soroban_sdk::String::from_str(env, "Adjust the transfer amount to be within your confirmed balance."),
            ),
            RejectionCode::BondAlreadyMatured => (
                RejectionCategory::MarketAndLifecycle,
                RemediationType::TerminalBlock,
                false,
                0,
                soroban_sdk::String::from_str(env, "Bond has reached maturity date; new subscriptions and transfers are closed."),
                soroban_sdk::String::from_str(env, "Redeem principal via the redemption portal or participate in active bond series."),
            ),
            RejectionCode::TransferBlocked => (
                RejectionCategory::JurisdictionalSanctions,
                RemediationType::ContactSupport,
                false,
                0,
                soroban_sdk::String::from_str(env, "Transfer action blocked by administrative or compliance lock."),
                soroban_sdk::String::from_str(env, "Reach out to protocol settlement officers to review transfer hold status."),
            ),
            RejectionCode::InvalidAmount => (
                RejectionCategory::InvestmentLimits,
                RemediationType::AdjustAmount,
                true,
                0,
                soroban_sdk::String::from_str(env, "Specified action amount must be strictly positive."),
                soroban_sdk::String::from_str(env, "Enter an amount greater than zero."),
            ),
        }
    }

    /// Normal & Retry Paths: Records a rejection explanation or idempotently updates
    /// retry count if the same rejection reoccurs for this investor.
    pub fn record_or_retry(
        &mut self,
        env: &Env,
        action_type: ActionType,
        investor: Address,
        bond_id: u64,
        code: RejectionCode,
    ) -> Result<InvestorRejectionExplanation, RejectionError> {
        if bond_id == 0 {
            return Err(RejectionError::ZeroBondId);
        }

        let now = env.ledger().timestamp();

        // Retry Path: check if previous rejection matches
        if let Some(prev_id) = self.investor_last_rejection.get(investor.clone()) {
            if let Some(mut existing) = self.records.get(prev_id) {
                if existing.code == code && existing.action_type == action_type && existing.bond_id == bond_id {
                    existing.retry_count += 1;
                    existing.recorded_at = now;
                    self.records.set(prev_id, existing.clone());
                    return Ok(existing);
                }
            }
        }

        // Normal Path: generate new explanation record
        let (category, remediation_type, is_retryable, retry_after_seconds, summary, remediation_step) =
            Self::derive_explanation_content(env, code);

        let explanation_id = self.next_id;
        self.next_id += 1;

        let record = InvestorRejectionExplanation {
            explanation_id,
            action_type,
            investor: investor.clone(),
            bond_id,
            category,
            code,
            remediation_type,
            is_retryable,
            retry_after_seconds,
            summary,
            remediation_step,
            recorded_at: now,
            retry_count: 0,
        };

        self.records.set(explanation_id, record.clone());
        self.investor_last_rejection.set(investor.clone(), explanation_id);

        env.events().publish(
            (Symbol::new(env, "investor_rejection_explained"),),
            (explanation_id, bond_id, code as u32),
        );

        Ok(record)
    }

    /// Authorization Path: Retrieves an explanation record, ensuring only the affected investor
    /// or the designated compliance admin can inspect it.
    pub fn get_explanation(
        &self,
        caller: &Address,
        explanation_id: u64,
    ) -> Result<InvestorRejectionExplanation, RejectionError> {
        caller.require_auth();

        let record = self.records.get(explanation_id).ok_or(RejectionError::ExplanationNotFound)?;

        if caller != &record.investor && caller != &self.admin {
            return Err(RejectionError::Unauthorized);
        }

        Ok(record)
    }

    /// Retrieves the most recent rejection explanation for an investor.
    pub fn get_last_investor_rejection(
        &self,
        caller: &Address,
        investor: &Address,
    ) -> Result<InvestorRejectionExplanation, RejectionError> {
        caller.require_auth();

        if caller != investor && caller != &self.admin {
            return Err(RejectionError::Unauthorized);
        }

        let explanation_id = self
            .investor_last_rejection
            .get(investor.clone())
            .ok_or(RejectionError::ExplanationNotFound)?;

        self.records.get(explanation_id).ok_or(RejectionError::ExplanationNotFound)
    }
}
