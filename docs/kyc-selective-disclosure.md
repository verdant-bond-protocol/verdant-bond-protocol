# KYC Data Minimization & Selective Regulator Disclosure Architecture

This document specifies the KYC data minimization strategy and access-controlled selective disclosure process for regulators in the Verdant Bond Protocol (resolving Issue #334).

---

## 1. Data Minimization Principles

To ensure regulatory compliance (SEC Reg D/S, EU MiFID II, GDPR, MAS) without broadcasting Personally Identifiable Information (PII) to a public blockchain, the protocol enforces strict separation between on-chain data and off-chain audit records.

### On-Chain Data Representation
Only two non-identifying fields touch the chain or are included in purchase transactions:
1. **Commitment Hash**: Cryptographic SHA-256 hash computed over investor wallet address, non-identifying eligibility tier, jurisdiction, user salt, and issue timestamp.
   $$\text{CommitmentHash} = \text{SHA256}(\text{Address} \parallel \text{Tier} \parallel \text{Jurisdiction} \parallel \text{Salt} \parallel \text{IssuedAt})$$
2. **Eligibility Tier**: Non-identifying operational tier:
   - `TIER_0_UNVERIFIED`
   - `TIER_1_RETAIL_STANDARD`
   - `TIER_2_ACCREDITED`
   - `TIER_3_INSTITUTIONAL`

### Zero-PII Storage Guarantee
- No names, physical addresses, tax IDs, passport numbers, or raw KYC document hashes are stored on-chain.
- On-chain contracts and public indexers can verify eligibility at purchase time solely using the on-chain commitment and eligibility tier.

---

## 2. On-Chain Eligibility Verification

When an investor attempts to purchase or subscribe to a bond tranche:
1. The client presents the `OnChainKycCommitment` payload.
2. The protocol verifies:
   - The commitment timestamp is unexpired ($\text{now} \le \text{ExpirationTimestamp}$).
   - The non-identifying eligibility tier matches or exceeds the required tranche tier.
3. No PII lookup is performed or required during on-chain execution.

---

## 3. Access-Controlled Selective Disclosure Process for Regulators

When an authorized financial regulator (e.g. SEC, FINMA, MAS, FCA) requires audit proof that a specific on-chain transaction or commitment was backed by a verified KYC check:

```
+------------------+         1. Present Auth Token & Commitment Hash        +-----------------------------+
|    Regulator     | -----------------------------------------------------> | Compliance Controller / API |
+------------------+                                                        +--------------+--------------+
         ^                                                                                 |
         |                                                                                 v
         |                   2. Access-controlled Audit Verification         +-----------------------------+
         +<---------------------------------------------------------------- |   KycCommitmentService      |
                             3. Return Selective Disclosure Package         +-----------------------------+
```

### Access Control & Verification Steps
1. **Regulator Authentication**: Requests to `POST /api/v1/compliance/kyc/selective-disclosure` require a valid regulator credential (`regulatorId` + `authorizationToken`).
2. **Audit Record Retrieval**: The off-chain compliance engine retrieves the encrypted audit entry matching the commitment hash.
3. **Cryptographic Proof Re-computation**: The service recomputes the SHA-256 commitment hash using the off-chain salt and verifies that it exactly matches the on-chain commitment hash (`proofValid = true`).
4. **Disclosure Package Generation**: Returns an auditable, timestamped package detailing the KYC status, provider reference, and disclosure metadata (`disclosedTo`, `disclosedAt`, `accessReason`).
