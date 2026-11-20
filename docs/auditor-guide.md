# Auditor Guide - Data Provenance and Exports

This document explains how auditors can retrieve verifiable ecological and transaction history bundles from the Verdant Bond Protocol API and verify their cryptographic integrity.

---

## Provenance Export Endpoints

The API provides two authenticated export endpoints optimized for audit compliance and deterministic provenance tracking.

### 1. Project Audit Export
*   **Endpoint**: `GET /projects/:id/export`
*   **Authentication**: Requires JWT Bearer Token (`JwtAuthGuard`).
*   **Response Format**: Deterministic JSON including:
    *   `generationMetadata`: Timestamps, exporter address, and payload checksum.
    *   `project`: Core registry values (methodology, developer, location).
    *   `documents`: Files linked to the project (IPFS CID hashes, file names).
    *   `reports`: Every oracle telemetry report submitted (sequestration mass, signatures, status).
    *   `relatedBonds`: Deployed bond IDs backing this specific project.

### 2. Bond Audit Export
*   **Endpoint**: `GET /bonds/:id/export`
*   **Authentication**: Requires JWT Bearer Token (`JwtAuthGuard`).
*   **Response Format**: Deterministic JSON including:
    *   `generationMetadata`: Timestamps, exporter address, and payload checksum.
    *   `bond`: Bond parameters (face value, credit types, schedules).
    *   `lifecycleEvents`: State transitions (Issued, Matured, Defaults).
    *   `holders`: Wallet addresses and current balances.
    *   `couponDistributions`: Period intervals, report IDs, and distributed credits.
    *   `retirements`: Credit retirement records (burn certificates, amounts).

---

## Verifying Integrity Checksums

Every data export payload contains a SHA-256 checksum calculated over the JSON fields sorted alphabetically. This proves that the data was not tampered with post-generation.

### Checksum Verification Script (Node.js)

Auditors can run the following script to verify the integrity of any downloaded export bundle:

```javascript
const fs = require('fs');
const crypto = require('crypto');

// Load export bundle
const bundle = JSON.parse(fs.readFileSync('project-export-1.json', 'utf8'));

// Extract generation metadata and checksum
const { checksum } = bundle.generationMetadata;

// Omit checksum field from calculation
const payloadCopy = JSON.parse(JSON.stringify(bundle));
delete payloadCopy.generationMetadata.checksum;

// Sort JSON keys alphabetically for deterministic output
const sortedData = JSON.stringify(payloadCopy, Object.keys(payloadCopy).sort());

// Compute SHA-256 hash
const calculatedChecksum = crypto.createHash('sha256').update(sortedData).digest('hex');

if (calculatedChecksum === checksum) {
  console.log('✓ Checksum matches! The data is verified and has not been tampered with.');
  console.log(`Hash: ${calculatedChecksum}`);
} else {
  console.error('✗ Checksum MISMATCH! The export bundle may have been altered.');
  console.error(`Expected: ${checksum}`);
  console.error(`Calculated: ${calculatedChecksum}`);
}
```

---

## Historical Certification Document Resilience & IPFS Fallback Strategy

Historical certification documents (such as Verra/Gold Standard carbon credits certification, project boundary shapefiles, baseline verification reports, and dispute evidence) are critical for regulatory compliance and audit trail integrity. To mitigate IPFS pin churn, provider downtime, and gateway rate-limiting, the protocol implements a multi-tiered resilience and caching architecture.

### 1. Document Caching & Tiered Retention Policy

The protocol segregates document storage into distinct retention tiers:

| Tier | Target Scope | Retention Period | Storage & Encryption |
|---|---|---|---|
| **Routine Documents** | Temporary drafts, non-audited collateral, previews | 30 days (`2,592,000s`) | Redis / Local Cache, SHA-256 integrity checksum |
| **Audit / Dispute-Relevant** | Historical certification documents, dispute evidence, oracle reports | 10 years / Indefinite (`315,360,000s`) | AES-256-GCM encrypted cache, SHA-256 integrity verification |

* **Audit Promotion**: Any document referenced in an on-chain dispute or regulatory audit can be promoted to the long-term retention tier via `POST /projects/:id/documents/:hash/flag-audit`.
* **Tamper-Evident Integrity**: All cached documents store a deterministic SHA-256 checksum that is validated upon every retrieval to guard against bitrot or tampering.

### 2. Multi-Gateway Failover & Proactive Availability Audits

Rather than waiting for an auditor to hit a broken IPFS link, the protocol executes automated resilience workflows:
* **Gateway Fallover**: Document retrieval attempts the primary gateway (`gateway.pinata.cloud`) and automatically cycles through public decentralized fallbacks (`ipfs.io`, `cloudflare-ipfs.com`, `dweb.link`).
* **Proactive Probing**: Scheduled jobs probe document availability every 6 hours across all gateways and classify health states (`available`, `degraded`, `cached_fallback`, `unavailable`).
* **Automated Cache Warming**: When primary gateway degradation is detected for an audit-relevant document, the system automatically fetches the payload from working fallback gateways and warms the local long-retention cache ahead of time.

### 3. Graceful Auditor Retrieval & Escalation Workflow

When an auditor requests a document via `GET /projects/:id/documents/:hash`:
1. **IPFS Available**: The document is served directly and cached opportunistically.
2. **IPFS Outage (Cached)**: If IPFS is down but the document was cached under the retention policy, it is served seamlessly with header/metadata `servedFrom: "cache"`.
3. **Temporarily Unavailable**: If all gateways fail and the document is not yet in cache, the API returns a structured `503 Service Unavailable` with retry and escalation guidance instead of a raw failure:
   ```json
   {
     "status": "temporarily_unavailable",
     "message": "Document is temporarily unavailable across IPFS gateways. A cached recovery or escalation has been initiated.",
     "hash": "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
     "retryAfterSeconds": 30,
     "escalationPath": "/projects/1/documents/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco/escalate"
   }
   ```
4. **Manual Escalation**: Calling `POST /projects/:id/documents/:hash/escalate` triggers priority retrieval across all peer nodes.

