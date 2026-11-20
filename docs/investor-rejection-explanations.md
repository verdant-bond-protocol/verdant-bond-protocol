# Investor-Facing Explanation for Rejected Eligibility or Transfer Actions

## Overview & Motivation

In regulated security token offerings, green bond subscriptions, and secondary-market debt transfers, participants frequently encounter regulatory hurdles—such as KYC tier requirements, Reg D accreditation rules, jurisdictional offering caps, secondary-market transfer restrictions, and sanctions screening.

Historically, failed actions surfaced raw contract errors (e.g., `BondError::Unauthorized`, `BondError::InsufficientSupply`), generic HTTP status codes, or leaky internal diagnostics.

This document specifies the architecture, execution paths, operational edge cases, recovery workflows, and privacy invariants for **investor-facing rejection explanations** across the Verdant Bond Protocol.

---

## Architecture Overview

The system operates across a dual-layer vertical slice:

1. **Soroban Contract Layer (`contracts/shared/src/rejection_explanation.rs`)**:
   - Maintains on-chain structured taxonomy: `RejectionCategory`, `ActionType`, `RejectionCode`, and `RemediationType`.
   - Formats deterministic summaries and remediation steps within bounded on-chain string storage.
   - Enforces cryptographic signer authentication (`caller.require_auth()`) for accessing individual rejection records.
   - Emits `investor_rejection_explained` contract events with explanation ID, bond ID, and rejection code.
2. **API Service Layer (`api/src/compliance/services/investor-rejection-explanation.service.ts`)**:
   - Translates internal ruleset evaluations (`EligibilityDecision`), contract exceptions, and transfer preconditions into clear, empathetic, and actionable guidance for investors.
   - Sanitizes context metadata to prevent leaking confidential compliance heuristics, internal risk scores, or counterparty PII.
   - Provides idempotent retry tracking (`retryCount`, `evaluatedAt`), safe remediation URLs, and role-based access control.

---

## Core Execution Paths

### 1. Normal Path

When an eligibility evaluation, subscription attempt, or secondary transfer fails:
- **Root Cause Categorization**: Mapped to standard categories:
  - `IDENTITY_AND_KYC`: Missing or expired identity verification.
  - `REGULATORY_ACCREDITATION`: Tranche requires accredited investor certification (e.g., US Reg D 506(c)).
  - `JURISDICTIONAL_SANCTIONS`: Comprehensive embargo or restricted address.
  - `INVESTMENT_LIMITS`: Non-accredited retail offering cap exceeded.
  - `MARKET_AND_LIFECYCLE`: Bond already matured; transfer window closed.
  - `BALANCE_AND_ESCROW`: Insufficient confirmed token balance.
- **Actionable Remediation**:
  - `remediationType`: `SELF_SERVICE`, `DOCUMENT_UPLOAD`, `ADJUST_AMOUNT`, `WAIT_COOLDOWN`, `CONTACT_SUPPORT`, or `NON_REMEDIABLE`.
  - `actionSteps`: Sequential, clear instructions guiding the investor to resolution (e.g., "Submit government ID via /compliance/kyc", "Select STANDARD tranche").
  - `remediationUrl`: Direct link to portal workflow.
  - `isRetryable`: `true` for remediable conditions, `false` for terminal blocks.

### 2. Failure Path

- **Address Validation**: All addresses are strictly validated as valid Stellar public keys. Invalid addresses reject with `BadRequestException('Invalid Stellar address')`.
- **Numeric Integrity**: Bond IDs must be positive integers; amounts must be non-negative. Negative or zero values trigger `BadRequestException`.
- **Record Not Found**: Missing audit IDs throw `NotFoundException`.

### 3. Retry Path

- **Idempotent Aggregation**:
  - Repeated failures with identical criteria (`investorAddress:actionType:code:bondId`) do not pollute the database with duplicate records.
  - Instead, the existing record is updated with incremented `retryCount` and refreshed `evaluatedAt` timestamp.
  - The original `auditId` is preserved for consistent support ticket tracking.

### 4. Authorization Path

- **Privacy Guard**: Explanations can only be accessed by:
  1. The affected investor whose wallet address matches `sanitizedContext.investorAddress`.
  2. Protocol compliance officers or administrators with `admin` or `compliance_officer` roles.
- Any attempt by unauthorized third parties or eavesdroppers to inspect another investor's rejection details is rejected with `ForbiddenException`.

---

## Operational Edge Cases & Failure Modes

| Edge Case / Scenario | Root Cause | System Response & Guidance |
| :--- | :--- | :--- |
| **Secondary Transfer Counterparty Missing KYC** | Sender is compliant, but recipient has not completed KYC verification. | Action rejected with `TRANSFER_COUNTERPARTY_RESTRICTED`. Explanation clarifies that the recipient must complete KYC; sender's balance is untouched. |
| **Retail Offering Cap Exceeded** | Non-accredited retail investor enters amount above statutory jurisdiction ceiling. | Action rejected with `OFFERING_CAP_EXCEEDED`. Explanation states the maximum permitted amount and provides option to upgrade to accredited status. |
| **Matured Bond Transfer Attempt** | Bond lifecycle has progressed to maturity; trading is frozen. | Action rejected with `BOND_MATURED_OR_INACTIVE`. Explanation directs holder to redemption portal to claim principal. |
| **Sanctions Restriction Appeal** | Wallet matches an embargo or sanctions list. | Action rejected with `SANCTIONED_ADDRESS`. `isRetryable` is set to `false`, and investor is provided contact instructions for formal compliance appeal. |
| **Redis Cache Interruption** | API service cannot reach Redis cluster during explanation generation. | In-memory map guarantees immediate response; persistence resumes upon reconnect without investor impact. |

---

## Recovery and Rollback Procedures

### Investor Self-Service Recovery

1. **Document Refresh**:
   - For `KYC_EXPIRED` or `KYC_REQUIRED`: Investor uploads documents via `/compliance/kyc`.
   - Upon provider verification, the investor's status transitions to `VERIFIED`.
   - The investor retries the action; the rules engine grants eligibility.
2. **Accreditation Certification**:
   - For `ACCREDITATION_REQUIRED`: Investor uploads CPA/attorney verification letter or switches to an unrestricted tranche (`STANDARD`).
3. **Cap Adjustment**:
   - For `OFFERING_CAP_EXCEEDED`: Investor lowers the input amount to comply with local statutory limits.

### Operational Dispute & Rollback

- In the event of a false-positive sanctions or KYC block, compliance officers can execute an administrative review and update the investor's record in `KycStoreService`.
- Historical explanation records remain intact in the audit trail with immutable timestamps for regulatory examination.

---

## Financial & Privacy Invariants

1. **Confidentiality / Sensitive Boundary**:
   - In accordance with `docs/sensitive-content-boundaries.md`, explanations never expose internal screening algorithms, raw risk scores, internal blacklist labels, or counterparty personal data.
2. **Deterministic Explanations**:
   - For any given `(RejectionCode, Tranche, Jurisdiction)`, the derived category, remediation type, and action steps are deterministic and reproducible.
3. **Audit Idempotency**:
   - Retries under identical constraints increment `retryCount` and preserve the stable `auditId`.
