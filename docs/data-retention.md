# Data Retention Policy

This document outlines the retention rules and the automated cleanup processes for operational data within the Verdant Bond Protocol. 

As per the requirements, data must not accumulate indefinitely. We have classified data into specific types with strict retention requirements.

## Retention Classifications

| Data Type | Retention Period | Description |
|-----------|------------------|-------------|
| **Telemetry** | 30 days | Application and system telemetry data. |
| **Exports** | 7 days | Temporary files generated for data exports. |
| **Support Evidence** | 5 years | Evidence provided for support tickets or oracle challenges. Excludes records linked to active disputes. |
| **Audit Logs** | 7 years | KYC audit logs and other critical operational audit trails. |

## Automated Cleanup

The `DataRetentionService` runs a daily cron job at midnight to enforce these limits on the `data/` directory.

- **Storage Location**: The service sweeps the `data/telemetry`, `data/exports`, `data/evidence`, and `data/kyc` directories.
- **Dry Run / Reporting**: Before deletion, the service logs all affected files and their ages.
- **Protection**: Files in the `evidence` directory that match the ID of an active or acknowledged `OracleIncident` will be skipped during the cleanup phase to protect active disputes.

## Deletion safety and verification (#411)

Tested by `api/src/ops/data-retention.lifecycle.spec.ts`, which runs the job against a real
temporary directory with controlled file mtimes. `runCleanupJob()` returns a per-type
report of `{ deleted, held, errors }`.

### What the job may delete

- **Scope:** only regular files directly inside the four classified directories. Other
  directories under `DATA_DIR`, subdirectories and anything outside are never touched.
- **Age rule:** a file is deleted when its age is strictly greater than the retention
  period. A file exactly at the limit is kept.
- **The live KYC store is never expired.** `data/kyc/kyc-records.json`, the KYC store's
  current-state file (`KYC_STORE_DIR` defaults to `data/kyc`), is skipped however old its
  mtime. The store rewrites this file (temp file plus rename) on every change, so its mtime
  is the time of the last change, not the age of the data. Before, it could be deleted after
  seven years without a KYC change, or on the first run after a restore that preserved an
  mtime more than seven years old. The append-only `kyc-audit.log.jsonl` still follows the
  7-year rule.
- **Evidence holds:** expired evidence whose file name contains the id or subject of any
  active or acknowledged oracle incident is held.
  - Holds are loaded once per run and paged to the end. Before, they were loaded with two
    queries per file and capped at 1,000 incidents, so a hold beyond that cap was ignored.
  - Resolving the incident releases the hold on the next run.

### Failure and retry

| Situation | Behaviour |
|---|---|
| Incident store unreachable | Fails closed: all expired evidence is held for this run; other types are still cleaned |
| A file cannot be deleted (permissions, I/O) | Counted in `errors` and logged; the rest of the run continues |
| A file was already removed by a concurrent or earlier run | Treated as done, not as an error. Runs are idempotent and safe to overlap |
| `DATA_DIR` or a classified directory is missing | Nothing to do; the report is all zeros |

Deletion is irreversible. To recover a file deleted in error, restore it from backup and
set its mtime, or move it out of the classified directory. To roll back the job's behaviour,
revert `data-retention.service.ts`. Nothing is persisted by the job itself.
