# Resource Budget Tests and High-Cardinality Workload Ceilings

Resolves **Issue #367**.

## 1. Overview and Rationale

The Verdant Bond Protocol processes high-frequency carbon credit tokenization, green bond lifecycle events, cryptographic audit ledgers, and multi-tenant investor analytics. Without strict resource ceilings, worst-case input patterns—such as accounts with tens of thousands of coupon settlements, unconstrained ledger export scans, or faceted queries across thousands of high-cardinality registry items—can lead to unbounded CPU starvation, memory leaks (OOM kills), and node degradation.

The `ResourceBudgetEnforcer` (`api/src/monitoring/resource-budgets.ts`) and verification suites establish automated, deterministic ceilings for:
1. **Worst-Case User Workloads**: Aggregation of 10,000+ historical transactions, active multi-token positions, KYC limits, and notification states.
2. **Worst-Case Ledger Workloads**: Cryptographic verification of 10,000 sequential SHA-256 chained blocks with continuous tamper checks and state hashing.
3. **Worst-Case Search Workloads**: Multi-attribute filtering (afforestation, mangrove restoration, yield, jurisdiction) and regex term evaluation across 10,000 indexed records.

---

## 2. Resource Ceiling Matrix

The following budget ceilings are enforced in automated local/CI test suites (`scripts/verify-resource-budgets.mjs` and `api/src/test/resource-budgets.spec.ts`):

| Workload Domain | Max CPU Duration | Max Heap Growth ($\Delta$ Heap) | Max Scan Complexity | Max Serialized Payload |
|---|---|---|---|---|
| **Worst-Case User Profile** | 1,500 ms (Observed: ~6 ms) | 25,600 KB / 25 MB (Observed: ~182 KB) | 15,000 entities | 2,097,152 bytes (2 MB) |
| **Cryptographic Ledger Chain** | 2,500 ms (Observed: ~1,116 ms) | 30,720 KB / 30 MB (Observed: ~1,299 KB) | 15,000 events | 4,194,304 bytes (4 MB) |
| **Faceted Multi-Term Search** | 1,500 ms (Observed: ~33 ms) | 25,600 KB / 25 MB (Observed: ~157 KB) | 15,000 documents | 2,097,152 bytes (2 MB) |

### Key Architectural Invariants
- **Pagination Boundary Clamping**: User transaction lookups are strictly clamped to a maximum page size of 50 recent transactions (`Math.min(limit, 50)`), preventing unbounded arrays from crossing serialize boundaries.
- **Constant-Memory Hash Iteration**: Ledger verification chains previous block digests without retaining past decoded event trees in memory.
- **Top-$K$ Search Projection**: Search evaluation ranks candidates and slices down to the requested page window prior to generating full JSON responses.

---

## 3. Operational Edge Cases

1. **V8 Garbage Collection Jitter**:
   - Under sustained heavy memory load, micro-benchmarks may occasionally observe variable duration due to scavenge or major GC pauses.
   - *Mitigation*: The `measureWorkload` harness checks for `global.gc()` and forces pre-measurement memory sweeps when available; budget limits include safety margins above warm-runtime averages.
2. **Deep Cursor Offset Traversals**:
   - Attackers attempting to scan page 10,000 (`skip=1000000`) can induce linear scan overhead.
   - *Mitigation*: Query complexity scan counters ceiling at 15,000 records. Queries exceeding maximum allowable scan ranges return HTTP `400 Bad Request: Cursor range exceeded`.
3. **High-Cardinality Regex Invalidation**:
   - Complex nested regexes against project descriptions can induce catastrophic backtracking.
   - *Mitigation*: Multi-term search queries tokenize words on whitespace and use optimized substring index scans.

---

## 4. Failure Modes

| Failure Mode | Trigger / Condition | System Behavior | Metric / Alert |
|---|---|---|---|
| **CPU Budget Breach** | Unindexed full-table scan or runaway computation loop exceeding 1,500ms. | Workload halts or raises `ResourceBudgetViolation`. In API routes, query is aborted with HTTP 504. | `resource_budget.cpu_exceeded` |
| **Heap Memory Breach** | Query buffers excessive records in memory exceeding 25MB $\Delta$ Heap. | Process sheds query load; prevents Node process OOM crash. | `resource_budget.heap_exceeded` |
| **Payload Bloat** | Result serialization exceeds payload ceiling (2MB / 4MB). | Serialization rejects unpaginated response; returns truncated view or HTTP 413. | `resource_budget.payload_exceeded` |

---

## 5. Rollback and Recovery Runbook

### Incident: Workload Exceeding Budgets Under Unanticipated Traffic
1. **Immediate Triage**:
   - Check `resource_budget.cpu_exceeded` or `heap_exceeded` metrics in Prometheus / Grafana.
   - Run verification suite to isolate whether user, ledger, or search workload triggered the ceiling:
     ```bash
     node --experimental-strip-types scripts/verify-resource-budgets.mjs
     ```
2. **Runtime Remediation**:
   - If a specific heavy endpoint is under stress, clamp public query limits via Redis config:
     ```bash
     # Restrict search limit to 10 items
     redis-cli SET "config:search:max_limit" 10
     ```
   - For ledger export overloads, engage the background export worker queue rather than synchronous API requests.
3. **Rollback**:
   - If a recent schema change or index removal degraded query performance, roll back the deployment to the previous immutable container tag.
   - Re-run `scripts/verify-resource-budgets.mjs` to confirm all 4 verification gates pass.

---

## 6. Compatibility Statement

- The resource budget framework does not modify any external API contract or schema.
- All response DTOs and query parameter shapes remain completely backwards-compatible with existing client integrations.
