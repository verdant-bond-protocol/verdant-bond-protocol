# Oracle Anomaly Circuit Breaker Specification

This document details the statistical anomaly detection thresholds, blast radius scoping, and governed resumption procedures for the Oracle Circuit Breaker in the Verdant Bond Protocol (resolving Issue #332).

---

## 1. Statistical Anomaly Detection & Tradeoff Analysis

The circuit breaker continuously monitors incoming project performance telemetry and multi-provider reports to prevent corrupted or anomalous data from driving coupon payouts or secondary market trading.

### Detection Thresholds
1. **Statistical Z-Score Deviation ($N = 3.0$ Sigma)**:
   - Measures standard deviation from trailing historical project performance observations:
     $$Z = \frac{|x - \mu|}{\sigma}$$
   - Any report exceeding $Z > 3.0$ triggers an automatic circuit breaker pause.
2. **Cross-Source Variance (Max Relative Tolerance: 35%)**:
   - Compares independent report estimates for the same project-period against the cross-source median.
   - Any provider report exceeding $2 \times \text{Tolerance}$ (critical severity) triggers an automatic pause.

### False-Positive vs. False-Negative Tradeoffs

| Z-Score Threshold ($N$) | False-Positive Rate | False-Negative Risk | Protocol Operational Impact | Recommendation |
|---|---|---|---|---|
| **$N = 2.0$ Sigma** | High (~4.5%) | Extremely Low | Frequent false alarms during legitimate project volatility | Too sensitive |
| **$N = 3.0$ Sigma** | **Balanced (~0.27%)** | **Optimal** | **Catches genuine bugs, hacks, and extreme anomalies without interrupting normal operations** | **Selected Default** |
| **$N = 4.0$ Sigma** | Extremely Low (<0.01%) | High | Risks letting malicious/corrupted oracle data execute payouts before tripping | Too lenient |

---

## 2. Blast Radius Scoping

To avoid protocol-wide outages during localized project anomalies:
- **Scoped Blast Radius**: The circuit breaker pause is applied **strictly at the affected project level** (`projectId`) or tranche level (`projectId:tranche`).
- **Isolation**: Unaffected projects and bond tranches continue operating normally for coupon distribution and secondary trading.

---

## 3. Governed Resumption Process (No Automatic Timeout)

To ensure security against persistent oracle exploits:
- **Zero Automatic Timeout**: Circuit breaker pause states **NEVER** auto-expire or unpause automatically by elapsed time.
- **Multisig Governance Action Required**: Unpausing a circuit-breaker-halted project strictly requires an explicit API call to `POST /api/v1/oracle/circuit-breaker/resume` with:
  1. Authorized governance actor session.
  2. At least 2 valid multisig signatures (`multisigSignatures`).
  3. Documented, audited resumption reason (`resumptionReason`, min 10 characters).
