import { createHash, timingSafeEqual } from 'crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { encodeCid } from '../common/utils';
import { EvidenceManifest, EvidenceManifestSchema, canonicalJson } from './manifest-verification';

// ─────────────────────────────────────────────────────────────────────────────
// Cryptographic verification of imported external evidence (#393).
//
// Two independent checks, both off the network-free hot path unless enabled:
//
//   1. Authenticity -- an `ed25519` manifest is signed with the Stellar key in
//      `signer_public_key`, and that key must be the submitting provider or
//      one of its delegated signers. Unlike the legacy HMAC manifest (#113),
//      which every provider signs with one shared secret, this proves which
//      key produced the evidence.
//   2. Integrity -- evidence fetched from the IPFS gateway must hash to the
//      digest in its reference, so a compromised or misbehaving gateway
//      cannot substitute content behind a valid CID.
//
// See docs/evidence-verification.md for rollout modes and recovery.
// ─────────────────────────────────────────────────────────────────────────────

export type EvidenceSignatureMode = 'legacy' | 'ed25519' | 'required';

export type EvidenceVerificationCode =
  | 'SCHEMA_INVALID'
  | 'SIGNER_INVALID'
  | 'SIGNER_UNTRUSTED'
  | 'SIGNATURE_MALFORMED'
  | 'SIGNATURE_INVALID'
  | 'GENERATED_IN_FUTURE'
  | 'MANIFEST_EXPIRED'
  | 'EVIDENCE_BINDING_MISMATCH'
  | 'LEGACY_SCHEME_REJECTED'
  | 'MANIFEST_REQUIRED'
  | 'DIGEST_MISMATCH'
  | 'NOT_RETRIEVABLE'
  | 'TOO_LARGE';

export interface EvidenceVerificationResult {
  valid: boolean;
  code?: EvidenceVerificationCode;
  error?: string;
}

const ok: EvidenceVerificationResult = { valid: true };
const reject = (code: EvidenceVerificationCode, error: string): EvidenceVerificationResult => ({
  valid: false,
  code,
  error,
});

/** Clock skew tolerated for `generated_at` in the future. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export function resolveSignatureMode(raw = process.env.ORACLE_EVIDENCE_SIGNATURE_MODE): EvidenceSignatureMode {
  return raw === 'ed25519' || raw === 'required' ? raw : 'legacy';
}

/**
 * Delegated signers per provider, from `ORACLE_EVIDENCE_DELEGATED_SIGNERS`:
 * `{"G<provider>": ["G<signer>", ...]}`. A provider is always trusted to sign
 * for itself; delegation lets it sign with a separate, rotatable key. Invalid
 * JSON or non-G keys are ignored (fail closed: nothing extra is trusted).
 */
export function parseDelegatedSigners(raw = process.env.ORACLE_EVIDENCE_DELEGATED_SIGNERS): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [provider, signers] of Object.entries(parsed as Record<string, unknown>)) {
    if (!StrKey.isValidEd25519PublicKey(provider) || !Array.isArray(signers)) continue;
    const valid = signers.filter((s): s is string => typeof s === 'string' && StrKey.isValidEd25519PublicKey(s));
    if (valid.length) out.set(provider, new Set(valid));
  }
  return out;
}

/** The exact bytes an ed25519 manifest signature covers. */
export function manifestSigningBytes(manifest: Omit<EvidenceManifest, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(manifest), 'utf8');
}

/** Sign a manifest (used by providers' tooling and by tests). Hex-encoded. */
export function signManifestEd25519(
  unsigned: Omit<EvidenceManifest, 'signature' | 'signature_scheme' | 'signer_public_key'>,
  keypair: Keypair,
): EvidenceManifest {
  const body = { ...unsigned, signature_scheme: 'ed25519' as const, signer_public_key: keypair.publicKey() };
  return { ...body, signature: keypair.sign(manifestSigningBytes(body)).toString('hex') };
}

function decodeSignature(signature: string): Buffer | null {
  if (/^[0-9a-fA-F]{128}$/.test(signature)) return Buffer.from(signature, 'hex');
  if (/^[A-Za-z0-9+/]{86}==$/.test(signature)) return Buffer.from(signature, 'base64');
  return null;
}

export interface Ed25519VerifyOptions {
  delegatedSigners?: Map<string, Set<string>>;
  /** Evidence reference the report anchors; must equal `evidence_hash` when the manifest names one. */
  evidenceHash?: string;
  /** Maximum manifest age; 0/undefined disables the age check. */
  maxAgeSeconds?: number;
  now?: number;
}

/**
 * Verify an ed25519 manifest: schema, signer authorization, signature,
 * freshness and evidence binding. Checks run cheapest-first and the first
 * failure is returned with a stable code.
 */
export function verifyEd25519Manifest(
  manifest: unknown,
  providerAddress: string,
  options: Ed25519VerifyOptions = {},
): EvidenceVerificationResult {
  const parsed = EvidenceManifestSchema.safeParse(manifest);
  if (!parsed.success) return reject('SCHEMA_INVALID', `Schema validation failed: ${parsed.error.message}`);
  const { signature, ...unsigned } = parsed.data;

  const signer = unsigned.signer_public_key;
  if (!StrKey.isValidEd25519PublicKey(signer)) {
    return reject('SIGNER_INVALID', 'signer_public_key must be a Stellar ed25519 public key (G...)');
  }
  const delegated = options.delegatedSigners?.get(providerAddress);
  if (signer !== providerAddress && !delegated?.has(signer)) {
    return reject('SIGNER_UNTRUSTED', `signer ${signer} is not authorized to sign evidence for provider ${providerAddress}`);
  }

  const sig = decodeSignature(signature);
  if (!sig) return reject('SIGNATURE_MALFORMED', 'signature must be a 64-byte ed25519 signature, hex or base64');
  let verified = false;
  try {
    verified = Keypair.fromPublicKey(signer).verify(manifestSigningBytes(unsigned), sig);
  } catch {
    verified = false;
  }
  if (!verified) return reject('SIGNATURE_INVALID', 'Signature verification failed (tampered payload or wrong key)');

  const now = options.now ?? Date.now();
  const generatedAt = Date.parse(unsigned.generated_at);
  if (Number.isNaN(generatedAt)) return reject('SCHEMA_INVALID', 'generated_at must be an ISO-8601 timestamp');
  if (generatedAt - now > MAX_FUTURE_SKEW_MS) {
    return reject('GENERATED_IN_FUTURE', `generated_at ${unsigned.generated_at} is in the future`);
  }
  if (options.maxAgeSeconds && now - generatedAt > options.maxAgeSeconds * 1000) {
    return reject('MANIFEST_EXPIRED', `manifest is older than ${options.maxAgeSeconds}s`);
  }

  if (unsigned.evidence_hash !== undefined && unsigned.evidence_hash !== options.evidenceHash) {
    return reject(
      'EVIDENCE_BINDING_MISMATCH',
      `manifest is bound to evidence ${unsigned.evidence_hash}, report anchors ${options.evidenceHash ?? '<none>'}`,
    );
  }
  return ok;
}

/**
 * True when `bytes` hash to the digest named by `reference` (CIDv0 or hex
 * SHA-256). Following the protocol's hashing convention (ipfs/evidence.ts),
 * JSON evidence may also match by the hash of its canonical serialization.
 */
export function digestMatchesReference(bytes: Buffer, reference: string): boolean {
  const expected = encodeCid(reference);
  const matches = (candidate: Buffer) => {
    const digest = createHash('sha256').update(candidate).digest();
    return digest.length === expected.length && timingSafeEqual(digest, expected);
  };
  if (matches(bytes)) return true;
  try {
    return matches(Buffer.from(canonicalJson(JSON.parse(bytes.toString('utf8'))), 'utf8'));
  } catch {
    return false;
  }
}

export interface FetchEvidenceOptions {
  gateway: string;
  timeoutMs: number;
  maxAttempts: number;
  maxBytes: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Transient gateway failures worth another attempt; anything else is final. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Fetch evidence from the gateway and verify its digest.
 *
 * Retries (with linear backoff) only transient failures: network errors,
 * timeouts and 408/425/429/5xx. A digest mismatch, a 4xx, or oversize content
 * is deterministic and returned immediately -- retrying would only re-fetch
 * the same wrong bytes.
 */
export async function fetchAndVerifyEvidence(
  reference: string,
  options: FetchEvidenceOptions,
): Promise<EvidenceVerificationResult & { attempts: number }> {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError = 'no attempt made';

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await doFetch(`${options.gateway}${reference}`, { signal: controller.signal });
      if (!response.ok) {
        lastError = `gateway returned status ${response.status}`;
        if (!RETRYABLE_STATUS.has(response.status)) {
          return { ...reject('NOT_RETRIEVABLE', `Evidence ${reference}: ${lastError}`), attempts: attempt };
        }
      } else {
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          return { ...reject('TOO_LARGE', `Evidence ${reference} exceeds ${options.maxBytes} bytes`), attempts: attempt };
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > options.maxBytes) {
          return { ...reject('TOO_LARGE', `Evidence ${reference} exceeds ${options.maxBytes} bytes`), attempts: attempt };
        }
        if (!digestMatchesReference(bytes, reference)) {
          return {
            ...reject('DIGEST_MISMATCH', `Evidence ${reference}: content does not hash to the referenced digest`),
            attempts: attempt,
          };
        }
        return { ...ok, attempts: attempt };
      }
    } catch (error) {
      lastError = (error as Error).name === 'AbortError' ? `timed out after ${options.timeoutMs}ms` : (error as Error).message;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < options.maxAttempts) await sleep((options.backoffMs ?? 250) * attempt);
  }

  return {
    ...reject('NOT_RETRIEVABLE', `Evidence ${reference} could not be retrieved after ${options.maxAttempts} attempts: ${lastError}`),
    attempts: options.maxAttempts,
  };
}
