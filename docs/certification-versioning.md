# Certification Versioning & Coupon Provenance (issue #213)

Certifications are re-issued over time (re-certification, amendments). To prove
after the fact which document version justified a historical coupon payment,
every version is immutable and every coupon calculation links to its exact CID.

## Data model

- `CertificationVersion { version, cid, previousCid, kind, uploadedAt }`
  (`api/src/projects/interfaces/project.interface.ts`), stored append-only in
  Redis at `project:{id}:certifications` via
  `ProjectsService.addCertification()`. Entries are never modified or
  overwritten; each version points at a **distinct IPFS object** (every
  `uploadDocuments` file produces its own content-addressed hash and is
  recorded as a new version). Recording an already-known CID is rejected.
- Coupon linkage snapshots live append-only at `bond:{id}:coupon-certs` as
  `CouponCertification { bondId, periodIndex, reportId, certificationCid,
  gatewayUrl, certificationVersion, recordedAt }`.

## On-chain anchor (no contract change needed)

The provenance chain already exists on-chain and is read, not rewritten:

1. Coupon engine `PeriodInfo(bond_id, period_index).report_id` — the exact
   report used for that period's calculation (set in `distribute_coupon`).
2. Oracle consumer `Report(id).ipfs_evidence_hash` — the exact evidence CID.

`ProjectsService.getCouponCertification(projectId, bondId, periodIndex)`
resolves 1 → 2, matches the CID against the project's certification history
(`certificationVersion`, `null` when the evidence predates versioning), and
**snapshots the first resolution immutably** — later supersedes can never
rewrite which CID justified a past payment.

## Query paths

- `GET /projects/:id/certifications` — full version history (oldest first).
- `POST /projects/:id/certifications { cid, kind }` — record a new version.
- `GET /projects/:id/coupon-certification?bondId=&periodIndex=` — which
  certification justified coupon `(bondId, periodIndex)`.
- Existing `GET /projects/:id/provenance` and `GET /projects/:id/export`
  continue to surface documents/reports alongside.

## Tests

`api/src/projects/certification-versioning.spec.ts`: version chaining,
duplicate rejection, and a certification superseded twice while the historical
coupon query still returns the original CID from the snapshot.
