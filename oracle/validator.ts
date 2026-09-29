import { OracleReport } from './schemas';

export class OracleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OracleValidationError';
  }
}

/**
 * Pre-flight validation rules that mirror the on-chain checks in
 * `OracleConsumer.submit_report`. This prevents adapters from
 * producing reports that look structurally valid but will be rejected
 * by the Soroban contract during submission.
 */
export function validateForOnChain(report: OracleReport): void {
  // 1. Period validity (period_end > period_start)
  // On-chain: if period_end <= period_start { return Err(OracleError::InvalidSignature); }
  const start = new Date(report.period_start).getTime();
  const end = new Date(report.period_end).getTime();
  if (end <= start) {
    throw new OracleValidationError(
      `Invalid reporting period: period_end (${report.period_end}) must be after period_start (${report.period_start})`
    );
  }

  // 2. Sequestration (carbon_sequestered >= 0)
  // On-chain: if carbon_sequestered < 0 { return Err(OracleError::InvalidSignature); }
  if (report.carbon_sequestered < 0) {
    throw new OracleValidationError(
      `Invalid sequestration: carbon_sequestered must be non-negative, got ${report.carbon_sequestered}`
    );
  }

  // 3. Methodology format matches Soroban Symbol constraints
  // A Soroban Symbol can be at most 32 characters long, containing only a-zA-Z0-9_-
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(report.methodology)) {
    throw new OracleValidationError(
      `Invalid methodology: must be a valid Soroban Symbol (1-32 chars, a-z, A-Z, 0-9, _, -), got "${report.methodology}"`
    );
  }

  // 4. Evidence Hash format
  // For IPFS CIDv0 (default used by oracle evidence hash)
  if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(report.ipfs_evidence_hash)) {
    throw new OracleValidationError(
      `Invalid evidence hash: ipfs_evidence_hash must be a valid IPFS CIDv0 starting with 'Qm', got "${report.ipfs_evidence_hash}"`
    );
  }
}
