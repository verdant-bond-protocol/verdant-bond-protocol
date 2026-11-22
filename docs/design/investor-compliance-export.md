# Design Note: Investor Export with Privacy-Safe Compliance Fields (#619)

## Scope of This Vertical Slice

This slice delivers a streaming, privacy-safe investor compliance export in CSV and JSON formats under `exports`:

- **Includes**:
  - Strict field allowlist (`INVESTOR_COMPLIANCE_EXPORT_ALLOWLIST`) — source rows are projected field-by-field; unknown or newly added DB columns never leak.
  - Keyed HMAC-SHA256 pseudonymisation (`investorPseudonym`) using `INVESTOR_EXPORT_HMAC_KEY` from configuration (never hardcoded, never logged).
  - Role- and purpose-gated `walletAddress` inclusion (`MAINTAINER` or `SETTLEMENT_MANAGER` only, and only when `purpose` is `'regulatory_audit'` or `'sanctions_screening'`).
  - Streaming paginated export (`AsyncGenerator<string>`) in UTF-8 CSV and JSON with RFC 4180 quoting and spreadsheet formula-injection escaping (`=`, `+`, `-`, `@`, `\t`, `\r`).
  - Explicit completion footer (`# END_OF_EXPORT ...` in CSV, `status: "complete"` trailer in JSON) and error trailer (`# EXPORT_ERROR ...`) so a mid-stream failure never produces a truncated file that looks complete.
  - Dedicated RBAC permission `EXPORT_INVESTOR_COMPLIANCE`, `@RateLimit(...)`, and `AuditService` logging of requester, purpose, filters, and `asOfTimestamp` (never exported rows).
- **Deliberately Left Out**:
  - A "full PII" export mode (intentionally omitted to minimize privacy blast radius).
  - Server-side export file storage (exports stream directly to the response and are not persisted).

## Exported Fields & Sensitivity

| Field | Sensitivity | Treatment |
| --- | --- | --- |
| `investorPseudonym` | Pseudonymous | HMAC-SHA256(key, investorId); stable across exports with same key |
| `walletAddress` | Pseudonymous / Linkable | Included only for `MAINTAINER`/`SETTLEMENT_MANAGER` when purpose requires it; else `null` |
| `jurisdiction` | Non-PII Compliance | ISO-3166-1 alpha-2 country code |
| `investorCategory` | Non-PII Compliance | `retail`, `accredited`, or `institutional` |
| `kycStatus` | Compliance | `KycStatus` enum value |
| `kycVerifiedAt` | Compliance | ISO-8601 timestamp or `null` |
| `bondId` | Bond Reference | Integer bond identifier |
| `holdingsMinorUnits` | Financial | Integer minor units string (no floating point) |
| `asOfTimestamp` | Reproducibility | ISO-8601 snapshot timestamp |

## Retention Note

Exports are streamed directly in the HTTP response and are **not stored** by the server beyond the response lifecycle.

## Legal & Compliance Assumptions (Not Legal Advice)

A qualified compliance owner must confirm for each target jurisdiction (e.g., GDPR, CCPA, MiCA, SEC):
1. Whether HMAC-SHA256 pseudonymised identifiers (`investorPseudonym`) and `walletAddress` (when included) qualify as personal data under local law and require a Data Processing Agreement or lawful basis.
2. Whether `jurisdiction` + `investorCategory` + `holdingsMinorUnits` could allow singling out in small bond tranches (k-anonymity threshold).
3. Rotation policy for `INVESTOR_EXPORT_HMAC_KEY` (rotating the key breaks cross-export pseudonym linkability).
