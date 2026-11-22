# Design Note: Project Methodology Versioning at Issuance and Reporting (#622)

## Scope of This Vertical Slice

This slice delivers versioned project methodologies with cryptographic tamper detection, immutable active versions, bond-issuance pinning, report-time version validation, audit logging, and a re-runnable legacy migration:

- **Includes**:
  - `MethodologyVersion` model (`id`, `name`, `version`, `effectiveDate`, `documentContent`, `contentHash`, `status`: `draft | active | deprecated`, `approvedBy`, `approvedAt`).
  - `MethodologyVersioningService` enforcing immutability of active versions and SHA-256 hash verification on every read.
  - Bond issuance pinning (`BondMethodologyPin`) that locks `(methodologyId, version, contentHash)` onto a bond permanently.
  - Report-time validation (`ReportMethodologyBinding`) allowing the bond's pinned version or an explicitly approved `active` later version with a recorded reason and approver, while rejecting `draft`, `deprecated`, or unapproved versions.
  - Re-runnable, idempotent legacy migration mapping unversioned bonds/reports to `LEGACY-UNVERSIONED@0.0.0-legacy`, plus a documented rollback.
  - RBAC permission `MANAGE_METHODOLOGIES` (assigned to `MAINTAINER` and `ISSUER`; `INVESTOR` has read-only access) and `AuditService` trail.
- **Deliberately Left Out**:
  - On-chain Soroban `ProjectRegistry` / `BondIssuer` contract storage changes (the off-chain API pins and verifies the methodology hash; anchoring the hash on-chain is a follow-up contract upgrade).
  - Automatic IPFS pinning of methodology PDFs (uses canonical `documentContent` SHA-256 hash directly).

## Data Model

- `MethodologyVersion`: keyed by `${id}@${version}`
- `BondMethodologyPin`: keyed by `bondId` (immutable once created)
- `ReportMethodologyBinding`: keyed by `reportId`
- `LegacyMigrationRecord`: tracks `migratedBondIds` and `migratedReportIds` for idempotency and rollback

## Invariants

1. **Active Immutability**: Once `status === 'active'`, a methodology version's content, name, effectiveDate, and hash cannot be modified (`METHODOLOGY_IMMUTABLE`).
2. **Tamper Detection**: Every read recomputes `sha256(documentContent)` and compares against `contentHash` (`METHODOLOGY_TAMPER_DETECTED`).
3. **Permanent Bond Pin**: A bond's pinned methodology `(methodologyId, version, contentHash)` is write-once (`METHODOLOGY_ALREADY_PINNED`).
4. **Report Compliance**: Reports must use the bond's pinned version or an `active` later version with explicit `overrideReason` and `overrideApprovedBy` (`METHODOLOGY_VERSION_NOT_ALLOWED`).

## Migration & Rollback

- **Forward Migration**: `migrateLegacyBondsAndReports(bondIds, reportIds, actor)` creates/activates `LEGACY-UNVERSIONED@0.0.0-legacy` (`isLegacy: true`) if absent and pins any unpinned `bondIds` / binds any unbound `reportIds` to it. Safe to re-run; already-pinned bonds and bound reports are skipped.
- **Rollback**: `rollbackLegacyMigration(actor)` removes only the pins and report bindings recorded by the legacy migration (never touching non-legacy pins) and logs the rollback to `AuditService`.
