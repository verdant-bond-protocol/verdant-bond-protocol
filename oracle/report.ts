import { hashEvidence } from '../ipfs/evidence';
import { OracleReportSchema, OracleReport, ReportEvidence } from './schemas';
import { validateForOnChain } from './validator';
import { createSignedManifest, EvidenceManifest } from './manifest';

export interface BuildReportInput {
  project_id: string;
  provider: string;
  methodology: string;
  period_start: string;
  period_end: string;
  carbon_sequestered: number;
  confidence: number;
  evidence: ReportEvidence;
  manifest?: EvidenceManifest;
  raw_observations?: Record<string, unknown>;
  transformation_parameters?: Record<string, unknown>;
}

/**
 * Assemble a canonical oracle report, hash its evidence payload into
 * `ipfs_evidence_hash`, and validate the result against `OracleReportSchema`.
 */
export function buildOracleReport(input: BuildReportInput): OracleReport {
  const manifest =
    input.manifest ??
    createSignedManifest({
      project_id: input.project_id,
      provider: input.provider,
      methodology: input.methodology,
      period_start: input.period_start,
      period_end: input.period_end,
      carbon_sequestered: input.carbon_sequestered,
      confidence: input.confidence,
      raw_observations: input.raw_observations ?? input.evidence,
      transformation_parameters: input.transformation_parameters ?? {},
    });

  const evidence: ReportEvidence = {
    ...input.evidence,
    manifest,
  };

  const payload = {
    project_id: input.project_id,
    provider: input.provider,
    methodology: input.methodology,
    period_start: input.period_start,
    period_end: input.period_end,
    carbon_sequestered: input.carbon_sequestered,
    confidence: input.confidence,
    evidence,
    generated_at: new Date().toISOString(),
  };

  const { ipfs_evidence_hash } = hashEvidence(payload);

  const report = OracleReportSchema.parse({
    project_id: input.project_id,
    provider: input.provider,
    methodology: input.methodology,
    period_start: input.period_start,
    period_end: input.period_end,
    carbon_sequestered: input.carbon_sequestered,
    confidence: input.confidence,
    ipfs_evidence_hash,
    evidence,
  });

  validateForOnChain(report);

  return report;
}
