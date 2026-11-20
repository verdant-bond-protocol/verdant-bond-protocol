import { createHmac } from 'crypto';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Evidence manifest verification (issue #113).
//
// The repository's shared oracle package (`/oracle`) owns the signed-evidence
// manifest helpers, but wiring the API to import sibling package sources pulls
// the oracle worker's own transitive dependencies (`zod`, `axios`) into the API
// workspace, which cannot resolve them. The API consumes only the two verification
// entry points below (schema + HMAC), which are self-contained (node crypto +
// zod, both already API dependencies), so they are vendored here to keep the API
// pipeline green without importing the sibling package.
// ─────────────────────────────────────────────────────────────────────────────

/** ISO-8601 calendar date (`YYYY-MM-DD`), as used for reporting periods. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected date in YYYY-MM-DD format');

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
  /**
   * #393: `ed25519` manifests are signed with `signer_public_key` (see
   * evidence-verification.ts). Absent means the legacy shared-secret HMAC.
   */
  signature_scheme: z.enum(['hmac-sha256', 'ed25519']).optional(),
  /** #393: optional binding of the signature to the report's evidence reference. */
  evidence_hash: z.string().min(1).optional(),
});

export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

export const DEFAULT_MANIFEST_SECRET = 'verdant-oracle-provider-secret-key';

/** Canonical serialization of a JSON payload (keys sorted, compact). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const body = keys
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** Sign the canonical evidence JSON with a provider key (HMAC-SHA256 hex). */
export function signEvidence(payload: unknown, secret: string): string {
  return createHmac('sha256', secret)
    .update(canonicalJson(payload))
    .digest('hex');
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
    return {
      valid: false,
      error:
        'Signature verification failed (tampered payload or invalid secret)',
    };
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
    return {
      valid: false,
      error: `project_id mismatch: manifest=${manifest.project_id}, report=${report.project_id}`,
    };
  }
  if (manifest.methodology !== report.methodology) {
    return {
      valid: false,
      error: `methodology mismatch: manifest=${manifest.methodology}, report=${report.methodology}`,
    };
  }

  const reportStart =
    typeof report.period_start === 'number'
      ? new Date(
          report.period_start *
            (report.period_start < 1e11 ? 1000 : 1),
        )
          .toISOString()
          .slice(0, 10)
      : report.period_start;
  const reportEnd =
    typeof report.period_end === 'number'
      ? new Date(
          report.period_end * (report.period_end < 1e11 ? 1000 : 1),
        )
          .toISOString()
          .slice(0, 10)
      : report.period_end;

  if (manifest.period_start !== reportStart) {
    return {
      valid: false,
      error: `period_start mismatch: manifest=${manifest.period_start}, report=${reportStart}`,
    };
  }
  if (manifest.period_end !== reportEnd) {
    return {
      valid: false,
      error: `period_end mismatch: manifest=${manifest.period_end}, report=${reportEnd}`,
    };
  }
  if (manifest.carbon_sequestered !== Number(report.carbon_sequestered)) {
    return {
      valid: false,
      error: `carbon_sequestered mismatch: manifest=${manifest.carbon_sequestered}, report=${report.carbon_sequestered}`,
    };
  }

  return { valid: true };
}