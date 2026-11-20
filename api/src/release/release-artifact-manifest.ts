import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Reproducible release artifact manifests (#538).
 *
 * A manifest pins every shipped artifact (path, size, sha256) together with
 * the provenance needed to rebuild it (commit, toolchain, lockfile hashes).
 * It is deterministic: the same inputs give byte-identical JSON and the same
 * `digest`, whatever order files were collected in. A release key can sign
 * the digest (HMAC-SHA256) so verifiers can reject manifests not produced by
 * the release pipeline.
 *
 * `verifyManifest` rebuilds nothing; it compares a set of artifacts (e.g. the
 * output of an independent rebuild, or a downloaded release) to the manifest
 * and reports every discrepancy rather than stopping at the first.
 */

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;

export interface ReleaseArtifact {
  path: string;
  size: number;
  sha256: string;
}

export interface ReleaseProvenance {
  commit: string;
  /** Toolchain name -> pinned version, e.g. { node: 'v20.11.0', rust: '1.97.1' }. */
  toolchain: Record<string, string>;
  /** Lockfile path -> sha256 of its contents. */
  lockfiles: Record<string, string>;
}

export interface ReleaseManifestSignature {
  keyId: string;
  hmacSha256: string;
}

export interface ReleaseManifest {
  schemaVersion: number;
  release: string;
  provenance: ReleaseProvenance;
  artifacts: ReleaseArtifact[];
  /** sha256 over the canonical form of every field above. */
  digest: string;
  signature?: ReleaseManifestSignature;
}

export interface ArtifactInput {
  path: string;
  content: Buffer;
}

export type ArtifactReader = (path: string) => Promise<Buffer>;

export interface VerifyOptions {
  /** keyId -> secret of release keys trusted to sign manifests. */
  trustedKeys?: Record<string, string>;
  /** Fail when the manifest is unsigned. Default: true when trustedKeys is given. */
  requireSignature?: boolean;
  /** Provenance of the rebuild; any difference is reported as drift. */
  expectedProvenance?: Partial<ReleaseProvenance>;
}

export type SignatureStatus = 'valid' | 'missing' | 'invalid' | 'unknown_key' | 'not_checked';

export interface ManifestVerificationReport {
  ok: boolean;
  /** True when the only failures are unreadable artifacts: re-running may succeed. */
  retryable: boolean;
  digestValid: boolean;
  signature: SignatureStatus;
  missing: string[];
  unexpected: string[];
  mismatched: Array<{ path: string; expectedSha256: string; actualSha256: string; expectedSize: number; actualSize: number }>;
  unreadable: Array<{ path: string; error: string }>;
  provenanceDrift: Array<{ field: string; expected: string | undefined; actual: string | undefined }>;
}

export class ReleaseManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseManifestError';
  }
}

export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Normalises to a relative, forward-slash path; rejects absolute or escaping paths. */
export function normaliseArtifactPath(path: string): string {
  const normalised = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    normalised === '' ||
    normalised.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalised) ||
    normalised.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new ReleaseManifestError(`Artifact path must be relative and inside the release root: ${path}`);
  }
  return normalised;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function digestOf(manifest: Omit<ReleaseManifest, 'digest' | 'signature'>): string {
  return sha256Hex(
    canonical({
      schemaVersion: manifest.schemaVersion,
      release: manifest.release,
      provenance: manifest.provenance,
      artifacts: manifest.artifacts,
    }),
  );
}

export function buildManifest(
  release: string,
  provenance: ReleaseProvenance,
  inputs: ArtifactInput[],
): ReleaseManifest {
  if (!release.trim()) throw new ReleaseManifestError('Release name is required');
  if (!/^[0-9a-f]{7,64}$/i.test(provenance.commit)) {
    throw new ReleaseManifestError(`Provenance commit must be a git sha: ${provenance.commit}`);
  }
  if (inputs.length === 0) throw new ReleaseManifestError('A release needs at least one artifact');

  const seen = new Set<string>();
  const artifacts = inputs
    .map((input) => {
      const path = normaliseArtifactPath(input.path);
      if (seen.has(path)) throw new ReleaseManifestError(`Duplicate artifact path: ${path}`);
      seen.add(path);
      return { path, size: input.content.length, sha256: sha256Hex(input.content) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const body = { schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION, release, provenance, artifacts };
  return { ...body, digest: digestOf(body) };
}

export function signManifest(manifest: ReleaseManifest, keyId: string, secret: string): ReleaseManifest {
  if (!secret) throw new ReleaseManifestError('Signing secret is required');
  return { ...manifest, signature: { keyId, hmacSha256: createHmac('sha256', secret).update(manifest.digest).digest('hex') } };
}

/** Deterministic JSON for committing or publishing a manifest. */
export function serialiseManifest(manifest: ReleaseManifest): string {
  return `${JSON.stringify(JSON.parse(canonical(manifest)), null, 2)}\n`;
}

function checkSignature(manifest: ReleaseManifest, options: VerifyOptions): SignatureStatus {
  const trusted = options.trustedKeys;
  if (!trusted) return manifest.signature ? 'not_checked' : 'missing';
  if (!manifest.signature) return 'missing';
  const secret = trusted[manifest.signature.keyId];
  if (!secret) return 'unknown_key';
  const expected = Buffer.from(createHmac('sha256', secret).update(manifest.digest).digest('hex'));
  const actual = Buffer.from(manifest.signature.hmacSha256);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? 'valid' : 'invalid';
}

function provenanceDrift(
  recorded: ReleaseProvenance,
  expected: Partial<ReleaseProvenance> | undefined,
): ManifestVerificationReport['provenanceDrift'] {
  if (!expected) return [];
  const drift: ManifestVerificationReport['provenanceDrift'] = [];
  if (expected.commit !== undefined && expected.commit !== recorded.commit) {
    drift.push({ field: 'commit', expected: expected.commit, actual: recorded.commit });
  }
  for (const group of ['toolchain', 'lockfiles'] as const) {
    const want = expected[group];
    if (!want) continue;
    const have = recorded[group] ?? {};
    for (const key of [...new Set([...Object.keys(want), ...Object.keys(have)])].sort()) {
      if (want[key] !== have[key]) drift.push({ field: `${group}.${key}`, expected: want[key], actual: have[key] });
    }
  }
  return drift;
}

/**
 * @param present paths available in the candidate release (relative to its root)
 * @param read    reads one candidate artifact
 */
export async function verifyManifest(
  manifest: ReleaseManifest,
  present: string[],
  read: ArtifactReader,
  options: VerifyOptions = {},
): Promise<ManifestVerificationReport> {
  const digestValid =
    manifest.schemaVersion === RELEASE_MANIFEST_SCHEMA_VERSION && digestOf(manifest) === manifest.digest;
  const signature = checkSignature(manifest, options);
  const requireSignature = options.requireSignature ?? options.trustedKeys !== undefined;

  const candidate = new Set(present.map(normaliseArtifactPath));
  const recorded = new Set(manifest.artifacts.map((a) => a.path));
  const missing: string[] = [];
  const mismatched: ManifestVerificationReport['mismatched'] = [];
  const unreadable: ManifestVerificationReport['unreadable'] = [];

  for (const artifact of manifest.artifacts) {
    if (!candidate.has(artifact.path)) {
      missing.push(artifact.path);
      continue;
    }
    let content: Buffer;
    try {
      content = await read(artifact.path);
    } catch (err) {
      unreadable.push({ path: artifact.path, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const actualSha256 = sha256Hex(content);
    if (actualSha256 !== artifact.sha256 || content.length !== artifact.size) {
      mismatched.push({
        path: artifact.path,
        expectedSha256: artifact.sha256,
        actualSha256,
        expectedSize: artifact.size,
        actualSize: content.length,
      });
    }
  }
  const unexpected = [...candidate].filter((path) => !recorded.has(path)).sort();
  const drift = provenanceDrift(manifest.provenance, options.expectedProvenance);

  const signatureOk = signature === 'valid' || (!requireSignature && (signature === 'missing' || signature === 'not_checked'));
  const hardFailure =
    !digestValid || !signatureOk || missing.length > 0 || unexpected.length > 0 || mismatched.length > 0 || drift.length > 0;

  return {
    ok: !hardFailure && unreadable.length === 0,
    retryable: !hardFailure && unreadable.length > 0,
    digestValid,
    signature,
    missing,
    unexpected,
    mismatched,
    unreadable,
    provenanceDrift: drift,
  };
}
