# Multi-Oracle Freshness & Outlier Monitoring (#617)

## Overview
`oracle/multi-oracle-monitor.ts` combines per-source staleness evaluation (`oracle/staleness.ts`) with cross-source anomaly detection (`oracle/anomaly.ts`) and exposes `POST /multi-oracle` on `oracle/monitor.ts`.

## Evaluation Pipeline
1. **Authorization**: If `authorizedSources` is configured, readings from unlisted `sourceId`s are rejected as `unauthorized` and excluded from quorum and consensus.
2. **Input Validation**: Negative, `NaN`, or `Infinity` carbon values or invalid ISO-8601 `observedAt` timestamps are rejected as `invalid_reading`.
3. **Freshness**: Each valid reading is evaluated against its methodology cadence + grace window (`computeStaleness`). Stale sources are excluded before outlier detection so expired data cannot skew the median.
4. **Outlier Filtering**: Fresh readings are passed to `assessCrossSource`. Sources deviating beyond the methodology tolerance are excluded as `outlier`.
5. **Consensus & Status**:
   - `healthy`: `inlierCount >= minQuorum` with no stale, outlier, or unauthorized rejections.
   - `degraded`: `inlierCount >= minQuorum` despite one or more excluded sources.
   - `critical`: `inlierCount < minQuorum` or `conflicting_sources` (`consensusCarbon` is `null`).

## Retry & Recovery
`MultiOracleMonitor` tracks per-source consecutive failures and provides `assessWithRetry(projectId, periodKey, fetchReadings, maxRetries)` to recover from transient oracle lag without lowering quorum guarantees.
