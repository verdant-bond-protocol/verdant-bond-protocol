import { z } from 'zod';
import { signEvidence } from '../ipfs/evidence';
import { isoDate } from './schemas';

export const EvidenceManifestSchema = z.object({
  project_id: z.string().min(1),
  provider: z.string().min(1),
  signer_public_key: z.string().min(1),
  methodology: z.string().min(1),
  period_start: isoDate,
  period_end: isoDate,
  carbon_sequestered: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  raw_observations: z.record(z.string(), z.unknown()),
  transformation_parameters: z.record(z.string(), z.unknown()),
  generated_at: z.string().min(1),
  signature: z.string().min(1),
});

export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

export interface CreateManifestInput {
  project_id: string;
  provider: string;
  signer_public_key?: string;
  signer_secret?: string;
  methodology: string;
  period_start: string;
  period_end: string;
  carbon_sequestered: number;
  confidence: number;
  raw_observations: Record<string, unknown>;
  transformation_parameters: Record<string, unknown>;
  generated_at?: string;
}

export const DEFAULT_MANIFEST_SECRET = 'verdant-oracle-provider-secret-key';
export const DEFAULT_SIGNER_KEY = 'VERDANT_ORACLE_KEY_V1';

/**
 * Generate a canonical signed evidence manifest tying raw observations,
 * methodology, transformations, provider identity, and final submitted values together.
 */
export function createSignedManifest(input: CreateManifestInput): EvidenceManifest {
  const generated_at = input.generated_at || new Date().toISOString();
  const signer_public_key = input.signer_public_key || DEFAULT_SIGNER_KEY;
  const signer_secret = input.signer_secret || DEFAULT_MANIFEST_SECRET;

  const unsignedPayload = {
    project_id: input.project_id,
    provider: input.provider,
    signer_public_key,
    methodology: input.methodology,
    period_start: input.period_start,
    period_end: input.period_end,
    carbon_sequestered: input.carbon_sequestered,
    confidence: input.confidence,
    raw_observations: input.raw_observations,
    transformation_parameters: input.transformation_parameters,
    generated_at,
  };

  const signature = signEvidence(unsignedPayload, signer_secret);

  return EvidenceManifestSchema.parse({
    ...unsignedPayload,
    signature,
  });
}

/**
 * Verify a manifest's schema and HMAC signature against the provider secret.
 */
export function verifyManifest(
  manifest: unknown,
  expectedSecret: string = DEFAULT_MANIFEST_SECRET,
): { valid: boolean; error?: string } {
  let parsed: EvidenceManifest;
  try {
    parsed = EvidenceManifestSchema.parse(manifest);
  } catch (err: any) {
    return { valid: false, error: `Schema validation failed: ${err.message}` };
  }

  const { signature, ...unsignedPayload } = parsed;
  const expectedSignature = signEvidence(unsignedPayload, expectedSecret);

  if (signature !== expectedSignature) {
    return { valid: false, error: 'Signature verification failed (tampered payload or invalid secret)' };
  }

  return { valid: true };
}

/**
 * Ensure that a manifest's values strictly match the report/DTO values.
 */
export function verifyManifestMatchesReport(
  manifest: EvidenceManifest,
  report: {
    project_id: string;
    methodology: string;
    period_start: string | number;
    period_end: string | number;
    carbon_sequestered: number;
  },
): { valid: boolean; error?: string } {
  if (manifest.project_id !== report.project_id) {
    return { valid: false, error: `project_id mismatch: manifest=${manifest.project_id}, report=${report.project_id}` };
  }
  if (manifest.methodology !== report.methodology) {
    return { valid: false, error: `methodology mismatch: manifest=${manifest.methodology}, report=${report.methodology}` };
  }

  const reportStart = typeof report.period_start === 'number'
    ? new Date(report.period_start * (report.period_start < 1e11 ? 1000 : 1)).toISOString().slice(0, 10)
    : report.period_start;
  const reportEnd = typeof report.period_end === 'number'
    ? new Date(report.period_end * (report.period_end < 1e11 ? 1000 : 1)).toISOString().slice(0, 10)
    : report.period_end;

  if (manifest.period_start !== reportStart) {
    return { valid: false, error: `period_start mismatch: manifest=${manifest.period_start}, report=${reportStart}` };
  }
  if (manifest.period_end !== reportEnd) {
    return { valid: false, error: `period_end mismatch: manifest=${manifest.period_end}, report=${reportEnd}` };
  }
  if (manifest.carbon_sequestered !== Number(report.carbon_sequestered)) {
    return { valid: false, error: `carbon_sequestered mismatch: manifest=${manifest.carbon_sequestered}, report=${report.carbon_sequestered}` };
  }

  return { valid: true };
}
