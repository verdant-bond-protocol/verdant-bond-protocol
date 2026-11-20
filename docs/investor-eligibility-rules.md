# Investor Eligibility & Jurisdiction-Specific KYC Rules Engine

This document outlines the architecture, ruleset specification, cryptographic attestation flow, sanctions list monitoring, and operational procedures for investor eligibility and compliance in the Verdant Bond Protocol (resolving Issue #198).

---

## 1. Architectural Overview

To comply with global regulatory frameworks governing debt offerings, green bonds, and environmental asset tokens (e.g., US SEC Reg D / Reg S, EU Prospectus Regulation / MiFID II, Singapore MAS frameworks), the protocol enforces jurisdiction-specific eligibility rules before allowing bond subscriptions.

Instead of hardcoded or scattered conditional checks across route handlers, compliance is governed by:
1. **Versioned, Auditable Ruleset Engine**: Rulesets are versioned (e.g., `2026.1`), self-contained, and compute a deterministic SHA-256 audit hash over canonical serialization for immutability and provenance tracking.
2. **Signed Eligibility Attestations**: Backend issues an Ed25519-signed attestation after verifying KYC status, accreditation, offering caps, and sanctions screening. The attestation is independently verifiable by backend services, smart contracts, or auditors without database access.
3. **Restricted Tranche Enforcement**: Subscriptions to restricted tranches (e.g., `RESTRICTED_ACCREDITED`, `GREEN_INSTITUTIONAL`) strictly require a valid, unexpired attestation matching the investor, bond, and tranche.
4. **Sanctions List Monitoring & Staleness Alerting**: Periodic daily refresh cadence (`0 0 * * *`) with automated staleness detection (>24 hours) and alert emission.

```
                      +-----------------------------+
                      |   Investor / Web3 Client    |
                      +--------------+--------------+
                                     |
               1. Request Attestation| (POST /compliance/attestation)
                                     v
                      +-----------------------------+
                      | ComplianceAttestationService|
                      +--------------+--------------+
                                     |
                         +-----------+-----------+
                         |                       |
                         v                       v
               +-------------------+   +--------------------+
               |KycStore / Status  |   |ComplianceRulesEngine|
               | (Verified/Accred) |   | (Jurisdiction/Caps) |
               +-------------------+   +----------+---------+
                                                  |
                                                  v
                                       +--------------------+
                                       |  SanctionsService  |
                                       |  (OFAC / Embargoes)|
                                       +--------------------+
                                     |
               2. Return Signed      | Ed25519 Signature
                  Attestation        v
                      +-----------------------------+
                      |   Investor / Web3 Client    |
                      +--------------+--------------+
                                     |
               3. Subscribe with     | Attestation + Tranche
                  Attestation        v
                      +-----------------------------+
                      |    BondsService.subscribe   |
                      |  (Independent Verification) |
                      +--------------+--------------+
                                     |
               4. Validated Sub      | Soroban Contract Call
                                     v
                      +-----------------------------+
                      |   Stellar Bond Contract     |
                      +-----------------------------+
```

---

## 2. Versioned Ruleset Specification

Rulesets implement the `VersionedRuleset` interface and are registered with `ComplianceRulesEngine`.

### Jurisdiction Rules

| Jurisdiction | Code | Allowed Tranches | Minimum KYC | Accreditation Required for Restricted | Retail Offering Cap |
|---|---|---|---|---|---|
| **United States** | `US` | `STANDARD`, `RESTRICTED_ACCREDITED` | `VERIFIED` | **Yes** (Reg D 506(c)) | None (Restricted tranche handles accredited flow) |
| **European Union** | `EU` | `STANDARD`, `RESTRICTED_ACCREDITED`, `GREEN_INSTITUTIONAL` | `VERIFIED` | **No** (Retail permitted with cap) | `100,000,000` minor units (~€1,000,000) for non-accredited |
| **United Kingdom** | `GB` | `STANDARD`, `RESTRICTED_ACCREDITED`, `GREEN_INSTITUTIONAL` | `VERIFIED` | **No** | `100,000,000` minor units (~£1,000,000) for non-accredited |
| **Singapore** | `SG` | `STANDARD`, `RESTRICTED_ACCREDITED`, `GREEN_INSTITUTIONAL` | `VERIFIED` | **Yes** | `20,000,000` minor units (~$200,000 SGD) for retail |
| **Switzerland** | `CH` | `STANDARD`, `RESTRICTED_ACCREDITED`, `GREEN_INSTITUTIONAL` | `VERIFIED` | **No** | None |
| **Global / Default** | `GLOBAL` | `STANDARD` | `VERIFIED` | **Yes** | `10,000,000` minor units |
| **Embargoed** | `CU`, `IR`, `KP`, `SY` | *None* | `NONE` | N/A | Blocked under comprehensive international sanctions |

### Deterministic Audit Hash
Rulesets produce a deterministic SHA-256 audit hash calculated from a canonical JSON serialization (sorted keys, stable encoding). This allows maintainers and auditors to verify that the active ruleset matches the approved governance hash:
```typescript
const hash = computeRulesetHash(ruleset);
```

---

## 3. Cryptographic Eligibility Attestation

### Payload Structure
```typescript
interface EligibilityAttestationPayload {
  investorAddress: string;   // Stellar G... public key
  bondId: number;            // Target bond offering
  tranche: TrancheType;      // STANDARD | RESTRICTED_ACCREDITED | GREEN_INSTITUTIONAL
  jurisdiction: string;      // Evaluated jurisdiction (e.g., 'US', 'EU')
  kycStatus: KycStatus;      // VERIFIED | ACCREDITED
  rulesetVersion: string;    // '2026.1'
  issuedAt: number;          // Unix timestamp in seconds
  expiresAt: number;         // Unix timestamp in seconds (default TTL: 1 hour)
  nonce: string;             // 32-hex character cryptographically random nonce
}
```

### Signing and Independent Verification
- **Signing**: The payload is canonically serialized into JSON and signed using the compliance authority's Stellar Ed25519 `Keypair` (`COMPLIANCE_SIGNING_KEY`).
- **Independent Verification**:
  ```typescript
  const verification = complianceAttestationService.verifyAttestation(attestation, {
    expectedInvestor: dto.investorAddress,
    expectedBondId: bondId,
    expectedTranche: dto.tranche,
    maxAgeSeconds: 3600,
  });
  ```
  Verification requires zero network requests or database queries, ensuring high performance and auditability across external layers.

---

## 4. Periodic Sanctions Screening & Staleness Alerting

1. **Screening Coverage**:
   - Address-level matching against OFAC Specially Designated Nationals (SDN) and protocol blacklists.
   - Country-level embargo enforcement (Cuba, Iran, North Korea, Syria).
2. **Refresh Cadence**:
   - Cadence: `0 0 * * *` (Daily at 00:00 UTC).
   - Maximum Staleness Threshold: `24 hours`.
3. **Staleness Alerting**:
   - If the sanctions list has not been refreshed within 24 hours, `SanctionsService.isStale()` evaluates to `true`.
   - The service raises an alert (`logger.error(...)`) and sets `alertRaised: true` on `getStatus()`.
   - Monitoring systems can poll `GET /api/v1/compliance/sanctions/status` or ingest emitted alerts.
4. **Manual / Administrative Refresh**:
   - Admins can refresh the sanctions list dynamically:
     ```http
     POST /api/v1/compliance/sanctions/refresh
     Authorization: Bearer <ADMIN_JWT>
     Content-Type: application/json

     {
       "additionalAddresses": ["GA..."]
     }
     ```

---

## 5. API Endpoints

### 1. `GET /api/v1/compliance/ruleset`
Returns the active versioned ruleset, allowed tranches by jurisdiction, offering caps, and the SHA-256 audit hash.
- **Access**: Public
- **Query Params**: `version` (optional)

### 2. `POST /api/v1/compliance/evaluate`
Pre-flight evaluation of an investor's eligibility without initiating a transaction.
- **Access**: Public / Authenticated
- **Body**:
  ```json
  {
    "investorAddress": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "bondId": 1,
    "tranche": "RESTRICTED_ACCREDITED",
    "jurisdiction": "US",
    "purchaseAmount": "50000000"
  }
  ```

### 3. `POST /api/v1/compliance/attestation`
Issues an Ed25519-signed attestation for the authenticated caller after verifying KYC records and ruleset criteria.
- **Access**: Authenticated (JWT required)
- **Body**:
  ```json
  {
    "bondId": 1,
    "tranche": "RESTRICTED_ACCREDITED",
    "jurisdiction": "US",
    "purchaseAmount": "50000000"
  }
  ```

### 4. `GET /api/v1/compliance/sanctions/status`
Returns sanctions list metadata, entry count, last refresh timestamp, cadence, and staleness alert state.
- **Access**: Public

### 5. `POST /api/v1/compliance/sanctions/refresh`
Triggers an immediate sanctions refresh and resets staleness metrics.
- **Access**: Admin (JWT + Admin key required)

---

## 6. Integration with Bond Subscriptions

When an investor subscribes to a bond (`POST /api/v1/bonds/:id/subscribe`):
1. **Restricted Tranches (`RESTRICTED_ACCREDITED`)**:
   - The client MUST supply `attestation` in the request body.
   - If missing, `BondsService` rejects with `403 Forbidden: Restricted tranche requires a signed eligibility attestation issued after KYC completion`.
   - The attestation signature is verified against the compliance public key, ensuring `investorAddress`, `bondId`, and `tranche` match.
2. **Sanctions Check**:
   - If the investor's address is listed on active sanctions, the subscription is blocked immediately with `403 Forbidden`.
3. **Offering Caps & Jurisdiction Constraints**:
   - If jurisdiction rules specify retail caps, amounts exceeding the cap without accredited KYC status are blocked with `403 Forbidden`.
