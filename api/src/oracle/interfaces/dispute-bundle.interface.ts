import { createHash } from 'crypto';
import { ChallengeRecord, ReportStatus } from './oracle.interface';

export const DISPUTE_BUNDLE_SCHEMA_VERSION = 1;

const ALPHABET_BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MULTIHASH_SHA2_256 = Buffer.from([0x12, 0x20]);

export interface DisputeEvidenceBundle {
  schemaVersion: number;
  bundleId: string;
  reportId: number;
  projectId: string;
  providerAddress: string;
  contestation: {
    status: ReportStatus | string;
    activeChallengesCount: number;
    challenges: ChallengeRecord[];
    primaryChallenge: ChallengeRecord | null;
  };
  performanceReport: {
    periodStart: number;
    periodEnd: number;
    carbonSequestered: string;
    methodology: string;
    ipfsEvidenceHash: string;
    providerSignature: string;
  };
  evidenceLinkage: {
    originalEvidenceHash: string;
    counterEvidenceHashes: string[];
    integrityVerified: boolean;
  };
  generatedAt: string;
  digest: string;
  cid: string;
}

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`);
  return `{${entries.join(',')}}`;
}

export function computeBundleDigest(
  bundleWithoutDigestAndCid: Omit<DisputeEvidenceBundle, 'digest' | 'cid'> | Record<string, any>,
): string {
  const { digest: _d, cid: _c, ...clean } = bundleWithoutDigestAndCid as any;
  const canonical = canonicalStringify(clean);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function encodeBase58btc(input: Buffer): string {
  let digits = [0];
  for (const byte of input) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeros = 0;
  for (const byte of input) {
    if (byte !== 0) break;
    leadingZeros += 1;
  }
  const out = Array(leadingZeros).fill(ALPHABET_BASE58[0]).join('');
  return out + digits.reverse().map((d) => ALPHABET_BASE58[d]).join('');
}

export function computeBundleCid(digestHex: string): string {
  const digestBuffer = Buffer.from(digestHex, 'hex');
  return encodeBase58btc(Buffer.concat([MULTIHASH_SHA2_256, digestBuffer]));
}

export function verifyDisputeEvidenceBundle(bundle: DisputeEvidenceBundle): {
  valid: boolean;
  reason?: string;
} {
  if (!bundle || typeof bundle !== 'object') {
    return { valid: false, reason: 'Bundle must be a valid non-null object' };
  }
  if (bundle.schemaVersion !== DISPUTE_BUNDLE_SCHEMA_VERSION) {
    return {
      valid: false,
      reason: `Unsupported schema version: expected ${DISPUTE_BUNDLE_SCHEMA_VERSION}, got ${bundle.schemaVersion}`,
    };
  }
  if (!bundle.reportId || !bundle.projectId) {
    return { valid: false, reason: 'Missing required report or project identification' };
  }

  const expectedDigest = computeBundleDigest(bundle);
  if (bundle.digest !== expectedDigest) {
    return {
      valid: false,
      reason: `Digest mismatch: expected ${expectedDigest}, got ${bundle.digest}`,
    };
  }

  const expectedCid = computeBundleCid(expectedDigest);
  if (bundle.cid !== expectedCid) {
    return {
      valid: false,
      reason: `CID mismatch: expected ${expectedCid}, got ${bundle.cid}`,
    };
  }

  return { valid: true };
}
