# Deterministic Duplicate Detection and Merge Review Workflow

This document specifies the deterministic duplicate detection engine, two-phase human merge review workflow, reversible merge execution, and tamper-evident audit logging for the Verdant Bond Protocol.

## Context & Motivation

In the Verdant Bond Protocol, environmental asset integrity and compliance depend on unambiguous entity resolution:
1. **KYC & Investor Identity Resolution:** Investors frequently register multiple Stellar wallet addresses or submit multiple verification requests through compliance providers (e.g. Synaps, Sumsub). Fragmented investor profiles risk bypassing subscription quotas, sanctions screening, or jurisdictional investor caps.
2. **Green Bond & Project Double-Counting Prevention:** Project developers submitting nature-based carbon projects (e.g., blue carbon mangroves, agroforestry parcels) must not be able to issue duplicate bonds or double-mint carbon credits against overlapping geographical parcels or identical registry certifications.
3. **Auditability & Reversibility:** Automated entity merging without human review risks destructive data loss or improper account consolidation. Every merge action must be reviewable by compliance officers, fully audited, and reversible should new evidence or customer clarification arise.

---

## Architectural Overview

```
                      +-----------------------------+
                      |   DeduplicationService      |
                      +--------------+--------------+
                                     |
             +-----------------------+-----------------------+
             |                                               |
             v                                               v
+---------------------------+                   +---------------------------+
|  KycDeduplicationAdapter  |                   | ProjectDeduplicationAdapt |
+-------------+-------------+                   +-------------+-------------+
              |                                               |
              v                                               v
       KycStoreService                                 ProjectsService
       & KycService                                    & IPFS Redundancy
```

### Core Components

1. **`similarity-scoring.ts`**: Pure mathematical, deterministic scoring functions:
   - Unicode NFKD normalization with diacritical mark stripping.
   - Levenshtein distance and bounded similarity ratio.
   - Character trigram Jaccard similarity.
   - Haversine great-circle distance and proximity scoring.
   - Order-independent SHA-256 candidate ID generation.
   - Deterministic stable sorting with unambiguous tie-breaking.
2. **`adapters/`**: Domain-specific entity adapters:
   - `KycDeduplicationAdapter`: Evaluates KYC records across Stellar wallet addresses for shared provider references, identity markers, and operator time proximity. Merges compliance tiers and expiration dates.
   - `ProjectDeduplicationAdapter`: Evaluates nature-based bond projects for identical IPFS document CIDs, normalized project titles, and geographical/scale proximity.
3. **`deduplication.service.ts`**: Central workflow orchestrator:
   - Enforces two-phase review workflow: `detect` -> `review/approve` -> `merge`.
   - Protects against state drift, self-merges, and transitive conflicts.
   - Emits hash-chained audit events to `AuditService`.
4. **`deduplication.controller.ts`**: Protected Admin REST API:
   - Enforces `JwtAuthGuard` and `AdminGuard`.
   - Provides endpoints for scan, candidate review, merge execution, and rollback.

---

## Deterministic Duplicate Detection

### Candidate ID Generation
Candidate duplicate IDs are strictly order-independent. Regardless of whether entity $A$ or entity $B$ is evaluated first:
$$\text{candidateId} = \text{SHA-256}(\text{entityType} \mathbin{\Vert} \text{sorted}(id_A, id_B))$$
This guarantees that repeated scans or distributed workers never generate conflicting duplicate records for the same pair.

### Multi-Attribute Scoring Weights

#### 1. KYC Records (`kyc_record`)
$$\text{Confidence} = \frac{0.50 \cdot S_{\text{providerRef}} + 0.30 \cdot S_{\text{identity}} + 0.20 \cdot S_{\text{proximity}}}{1.0}$$
- **$S_{\text{providerRef}}$**: Exact match on KYC provider applicant reference ($1.0$ if match, else $0.0$).
- **$S_{\text{identity}}$**: $\max(\text{JaccardTrigram}, \text{Levenshtein})$ over normalized identity/audit notes.
- **$S_{\text{proximity}}$**: Matching operator actor ($+0.5$) and linear decay for creation within 24 hours ($+0.5 \cdot (1 - \Delta t / 24\text{h})$).

#### 2. Green Bond Projects (`project`)
$$\text{Confidence} = \frac{0.45 \cdot S_{\text{cid}} + 0.35 \cdot S_{\text{title}} + 0.20 \cdot S_{\text{scale}}}{1.0}$$
- **$S_{\text{cid}}$**: Exact match on IPFS metadata CID ($1.0$ if match, else $0.0$).
- **$S_{\text{title}}$**: Normalized title similarity using character trigrams and edit distance.
- **$S_{\text{scale}}$**: Country match ($+0.5$) and carbon sequestration estimate relative difference ($+0.5$ if diff $\le 10\%$).

### Deterministic Tie-Breaking Order
Candidates are sorted using the following strict hierarchy:
1. `confidenceScore` DESC
2. `primaryId` ASC (lexicographical)
3. `secondaryId` ASC (lexicographical)

---

## Two-Phase Merge Review Workflow

```
[ PENDING_REVIEW ] ──( Review: Reject )────> [ REJECTED ]
        │
        ├──( Review: Dismiss )───> [ DISMISSED ]
        │
        └──( Review: Approve )───> [ APPROVED ]
                                       │
                               ( Execute Merge )
                                       │
                                       v
                                 [ MERGED ] ──( Reverse Merge )──> [ REVERSED ]
```

### Field-Level Conflict Resolution Strategies

When executing an approved merge, the reviewer specifies or accepts default field-level resolution strategies:

| Strategy | Behavior | Example |
|---|---|---|
| `PRIMARY_WINS` | Retain value from primary record. | Keep primary wallet address or project owner. |
| `SECONDARY_WINS` | Overwrite with value from secondary record. | Accept updated documentation from secondary. |
| `LATEST` | Pick the most recent timestamp. | Keep latest KYC expiration date: $\max(t_{\text{prim}}, t_{\text{sec}})$. |
| `UNION` | Combine distinct elements. | Aggregate document hashes or aliases. |
| `MANUAL` | Reviewer explicitly provides an override value. | Custom normalized legal name. |

---

## Operational Edge Cases & Failure Modes

| Situation | Behavior | Recovery / Mitigation |
|---|---|---|
| **State Drift Between Review & Merge** | Target entity modified after review. `liveDigest !== snapshotDigest`. Merge refused with `409 Conflict: STATE_DRIFT`. | Re-run scan to update candidate snapshot. Reviewer re-reviews updated diffs before merging. |
| **Transitive Merge Conflict ($A \to B$ then $B \to C$)** | Secondary record was already merged into another account in a previous merge. | Merge execution refused with `409 Conflict: Transitive conflict`. Reviewer must review against current canonical primary. |
| **Cyclic / Self-Merge ($A \to A$)** | Input entity IDs are identical. | Refused at scan and merge boundaries with `400 Bad Request: Self-merge invariant violation`. |
| **Merge Rollback State Drift** | Primary entity's attributes modified after merge was executed. | Rollback restores the journal's `preMerge*` snapshots. It does **not** re-fetch live state first (known limitation — see the determinism addendum below); verify the restored entity after reversal. |
| **Concurrent Review Race Condition** | Two reviewers concurrently review the same candidate. | The last write wins for non-merged candidates; a candidate already in `MERGED` cannot be re-reviewed (`409 Conflict`). Re-check status before acting on a review. |
| **Secondary Account Activity Post-Merge** | Merged secondary wallet attempts transactions. | Secondary record is set to `KycStatus.NONE` or `Inactive`, preventing authorization at the guard boundary. |

---

## Rollback & Disaster Recovery Runbook

### Emergency Merge Reversal Procedure
If an authorized merge is found to have erroneously combined distinct entities (e.g., shared corporate email address for two distinct beneficial owners):

1. **Locate Merge Journal ID:**
   ```bash
   GET /api/v1/deduplication/merges
   ```
   Retrieve the `mergeId` and inspect `preMergePrimary` and `preMergeSecondary` snapshots.

2. **Execute Reversible Rollback:**
   ```bash
   POST /api/v1/deduplication/merges/:mergeId/reverse
   Content-Type: application/json
   
   {
     "reason": "Compliance investigation confirms distinct beneficial ownership"
   }
   ```

3. **Verify Restored State:**
   - Primary record: Verify status and expiry reverted to `preMergePrimary`.
   - Secondary record: Verify re-activated from `NONE`/`Inactive` to original pre-merge status.
   - Audit trail: Verify `merge_reversed` entry recorded in `AuditService` with operator identity and reason.

---

## Determinism Contract (additive, v2)

Reproducibility is covered by `api/src/deduplication/deduplication.determinism.spec.ts`.

**What is stable:**
- Candidate IDs are `sha256(entityType:sorted(primaryId,secondaryId))`. Ordering uses a
  code-point comparator (`compareIds`) rather than `localeCompare`, so IDs and result
  order are identical across host locales and ICU versions.
- Similarity scores are rounded to 4 decimals; `stableSortCandidates` breaks ties by
  primary ID then secondary ID using the same comparator.
- `scanFingerprint` keeps its original definition (entity type, scanned count,
  candidate IDs, **excluding time**) and its original wire field.
- `scanFingerprintV2` is an **additional** field. It also hashes the confidence
  threshold, per-candidate scores, canonical state digests and review status, so a
  silent score/digest drift cannot leave a false "unchanged" signal. It is optional
  on `DeduplicationScanResult` — no existing consumer contract is broken.

**What is intentionally NOT deterministic:**
- `scannedAt`, `detectedAt`, review/merge timestamps and reversal timestamps are
  wall-clock values. Tests inject a fixed clock via `service.now`.
- Merge journal IDs include a timestamp and a UUID. Repeating the same merge must
  produce a distinct journal ID; do not use a journal ID as a content fingerprint.
- A scan result is a snapshot of the in-memory stores. Candidates and journals are
  **not durable** — a process restart loses them. Re-run a scan after restart and
  reconcile against the audit chain before trusting review state.

**Recovery / rollback behavior:**
- State drift between review and merge → `409 STATE_DRIFT`; re-scan, re-review, merge.
- Rejected audit writes are currently non-fatal. Check the audit chain when a
  review/merge must be evidentiary; a missing entry requires manual reconstruction.
- Reversal restores the journal's pre-merge snapshots but does not verify live state.
  After a reversal, confirm the entity values directly, then re-review and re-merge
  if the reversal itself must be undone.
- There is no "undo" for a scan; re-scanning refreshes snapshots and resets review
  state for drifted candidates.
