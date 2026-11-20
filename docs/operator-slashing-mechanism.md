# Operator Slashing & Fraud Protection Mechanism

## Overview
This specification defines the slashing mechanism for nature project operators who submit fraudulent, tampered, or invalid environmental performance data (e.g., satellite biomass reports, carbon sequestration metrics) to the Verdant Bond Protocol.

## Slashing Conditions & Severity Tiers
1. **Tier 1 - Minor Reporting Delay / Format Error**:
   - Warning issued; 5% penalty on current period operator management fee.
2. **Tier 2 - Data Inconsistency / Telemetry Mismatch**:
   - 25% slash of operator's staked performance bond (`VERDANT-STAKE`).
   - Temporary suspension of project token issuance pending oracle re-audit.
3. **Tier 3 - Fraudulent Biomass Data / Double-Counting Credits**:
   - 100% slash of operator stake.
   - Permanent blacklisting of project operator address in `project-registry`.
   - Slashed funds automatically transferred to the investor recovery pool (`default-insolvency-waterfall`).

## Challenge Lifecycle
- **Oracle Challenge Period**: Any protocol participant or auditor can challenge submitted performance data within 72 hours by posting a challenge bond.
- **Governance Dispute Arbitration**: Challenged reports are routed to multi-party verification in `governance` requiring 66% supermajority confirmation from verified environmental auditors.
