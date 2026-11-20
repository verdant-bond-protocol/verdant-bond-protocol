# Permission-Aware Export Pipeline with Bounded Memory and Cancellation Support

Resolves **Issue #357**.

## Overview
The Verdant Bond Protocol provides data export capabilities across green bonds, coupon distributions, investor holdings, compliance audits, and performance records. To prevent memory exhaustion (OOM), data leakage, and unresponsive long-running operations, the export pipeline implements:
1. **Permission-aware role enforcement & forbidden field stripping**
2. **Streaming chunk-based processing with $O(1)$ bounded memory overhead**
3. **Mid-stream cancellation support via `AbortSignal` and explicit cancellation endpoints**

---

## 1. Permission Matrix & Forbidden Field Stripping

Exports are categorized by `ExportType` and restricted by caller role:

| Export Type | Allowed Roles | Description |
|---|---|---|
| `PORTFOLIO` | `INVESTOR`, `ISSUER`, `AUDITOR`, `ADMIN` | Investor bond positions and valuations |
| `TRANSACTIONS` | `INVESTOR`, `ISSUER`, `AUDITOR`, `ADMIN` | Primary and secondary market trades |
| `HOLDINGS` | `INVESTOR`, `ISSUER`, `AUDITOR`, `ADMIN` | Current ledger token balances |
| `PERFORMANCE` | `INVESTOR`, `ISSUER`, `AUDITOR`, `ADMIN` | Yield, carbon credit coupons earned |
| `BONDS` | `ISSUER`, `AUDITOR`, `ADMIN` | Bond issuance parameters, tranches, covenants |
| `COUPONS` | `ISSUER`, `AUDITOR`, `ADMIN` | Coupon schedule, oracle verification hashes |
| `COMPLIANCE_AUDIT` | `AUDITOR`, `ADMIN` | Full-history compliance and attestation records |
| `KYC_PII` | `ADMIN` (explicitly forbidden to investors/issuers) | Administrative compliance verification data |

### Forbidden Field Stripping Rules

Before data is written to output streams, records are passed through `sanitizeRecordForCaller`:
- **`INVESTOR`:** Strips `ssn`, `nationalId`, `passportNumber`, `taxId`, `internalRiskScore`, `complianceNotes`, `signingKey`, `signingSeed`, `privateKey`, `nonce`, and `rawKycDocument`.
- **`ISSUER`:** Strips investor personal PII, `signingSeed`, `privateKey`, and `rawKycDocument`.
- **`AUDITOR`:** Strips internal cryptographic seeds (`signingSeed`, `privateKey`, `passwordHash`) while retaining audit trails and compliance risk scores.
- **Data Isolation Invariant:** Investors attempting to export records belonging to another `ownerUserId` receive an immediate `403 Forbidden` exception.

---

## 2. Bounded Memory Streaming Pipeline

Instead of accumulating full query results into memory arrays:
- The pipeline consumes records via `AsyncIterable<ExportableRecord[]>` in bounded chunks (default `batchSize: 50` or `100`).
- Each chunk is sanitized, serialized, and written to the destination sink/file.
- Garbage collection reclaims processed chunk objects immediately, maintaining constant $O(1)$ memory consumption whether exporting 100 or 1,000,000 records.

---

## 3. Cancellation Architecture

Exports can be cancelled via two mechanisms:
1. **HTTP Cancellation Endpoint:**
   ```http
   POST /api/v1/exports/:exportId/cancel
   ```
   Sets `export.status = 'cancelled'` and updates the Redis cancellation key `export:cancel:<exportId>`.
2. **`AbortSignal` Integration:**
   When client connections disconnect or worker timeouts fire, the abort signal propagates to the active generator.

### Clean Teardown
- Before processing each chunk, `streamExport` evaluates `abortSignal.aborted` and `isExportCancelled(exportId)`.
- If true, stream iteration terminates immediately.
- Partial temporary files are cleaned up.
- The export status transitions to `'cancelled'` with timestamp `cancelledAt`.

---

## 4. Operational Failure Modes & Recovery

### Failure Mode 1: Large Export OOM Attempt
- **Root Cause:** A client requests an export spanning millions of transaction logs.
- **Mitigation:** The stream pipeline bounds chunk sizes to 100 records and streams directly to disk, avoiding memory spikes.

### Failure Mode 2: Client Disconnect During Generation
- **Mitigation:** `AbortSignal` listener detects socket close, immediately terminating processing and preventing wasted CPU/IO cycles.

### Rollback / Recovery Steps
- If an export fails: status updates to `'failed'` with error diagnostics; caller may re-request with narrower date boundaries.
- Completed exports are retained for 30 days (`DEFAULT_RETENTION_DAYS`) and auto-expire via Redis TTL.

---

## 5. Field Redaction Modes (#506)

The role matrix above decides **which** fields a caller may not see. The
redaction mode decides **how** they are hidden. Logic lives in
[`api/src/exports/services/export-field-redaction.ts`](../api/src/exports/services/export-field-redaction.ts).

| Mode | Behaviour | Use when |
|---|---|---|
| `strip` (default) | Forbidden fields are removed — identical to the pre-#506 output. | Existing integrations; nothing changes unless a caller opts in. |
| `mask` | Forbidden fields stay in the record with a placeholder, so every role gets the same column set. | CSV/BI consumers that need a stable schema, or reviewers who must tell "redacted" from "absent". |

Opt in with `ExportStreamOptions.redaction = 'mask'` (or the new trailing
`redaction` argument of `ExportService.streamExportDataset`).

### Per-field strategy in `mask` mode

| Field (case-insensitive, any depth) | Strategy | Output |
|---|---|---|
| `signingKey`, `signingSeed`, `privateKey`, `passwordHash`, `nonce`, `rawKycDocument` | `strip` — in **every** mode | key removed; not even its presence leaks |
| `ssn`, `nationalId`, `passportNumber`, `taxId` | `partial` | last 4 characters when the value is ≥ 8 long (`*******6789`), else `[REDACTED]` |
| any other forbidden field (`internalRiskScore`, `complianceNotes`, …) | `mask` | `[REDACTED]` (a nested object is masked as one value) |

### Redaction manifest

Every `ExportStreamResult` (completed, cancelled, or failed) now carries
`redaction`: the policy version, mode, caller role, and for each redacted
path (`data.beneficiaries[].passportNumber`) the strategy and count. Store it
with the export record so auditors can see exactly what was withheld without
seeing the values.

### Authorization

- Export-type permission and investor ownership checks run **before** any
  redaction, in both modes — masking is never a way around them.
- A caller whose role has no field policy is refused (`403`) instead of
  being treated as "nothing to hide". This tightens `sanitizeRecordForCaller`,
  which previously exported such records unredacted if called directly;
  `streamExport` already refused them via the type matrix.
- An unknown mode is rejected with `400` before the source is read.

### Retry & recovery

Redaction is deterministic (no randomness, no clock), so retrying a failed or
cancelled export yields byte-identical records. The manifest is built fresh
per run, so a retry reports only its own redactions — never cumulative counts
from the failed attempt. A failed run's partial output should be discarded as
described in §4; nothing about redaction needs to be undone.

### Compatibility / migration

- Default mode is `strip`; existing callers and the existing
  `sanitizeRecordForCaller(record, caller)` two-argument form are unchanged.
- `ExportStreamOptions.redaction` and `ExportStreamResult.redaction` are
  optional, additive fields.
- Consumers moving to `mask` should expect string placeholders in fields
  that used to be absent (e.g. `internalRiskScore: "[REDACTED]"` instead of
  a missing number) and update schema validation accordingly.

Tests: `api/src/exports/services/export-field-redaction.spec.ts`.
