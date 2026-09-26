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
