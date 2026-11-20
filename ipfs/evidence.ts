import { createHash, createHmac } from 'crypto';
import { createAxiosHttpClient, HttpClient } from '../oracle/http';

/**
 * Evidence hashing & upload helpers for `ipfs_evidence_hash`.
 *
 * Evidence hashes are content-addressed: the canonical (key-sorted) JSON of
 * the report is hashed with SHA-256 and encoded as an IPFS CIDv0 (`Qm...`)
 * string, so the digest is deterministic, verifiable, and directly fetchable
 * from any IPFS gateway once pinned. No network round-trip is required to
 * produce the hash, which keeps adapters runnable offline against test data.
 */

const ALPHABET_BASE58 =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** SHA-256 multihash code (0x12) + digest length (0x20). */
const MULTIHASH_SHA2_256 = Buffer.from([0x12, 0x20]);

const GATEWAY = process.env.IPFS_GATEWAY || 'https://gateway.pinata.cloud/ipfs/';

/**
 * Raised for an evidence reference that is not a supported format (issue
 * #93). Supported: CIDv0 (`Qm...`, what `hashEvidence` below always
 * produces) or a raw 64-character hex SHA-256 digest (what `sha256Hex`
 * produces). Anything else -- wrong length, invalid encoding, an
 * unsupported CID version -- is rejected, not silently accepted.
 */
export class InvalidEvidenceHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEvidenceHashError';
  }
}

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

/**
 * Decode a base58btc string back to bytes (issue #93). Inverse of
 * `encodeBase58btc`. Throws if `input` contains a character outside the
 * base58btc alphabet.
 */
export function decodeBase58btc(input: string): Buffer {
  let bytes = [0];
  for (const char of input) {
    const value = ALPHABET_BASE58.indexOf(char);
    if (value < 0) {
      throw new InvalidEvidenceHashError(`Invalid base58btc character: "${char}"`);
    }
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (const char of input) {
    if (char !== ALPHABET_BASE58[0]) break;
    leadingZeros += 1;
  }
  return Buffer.concat([Buffer.alloc(leadingZeros), Buffer.from(bytes.reverse())]);
}

/** Base58btc (IPFS multibase) encoding of a byte buffer. */
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

/** IPFS CIDv0 (`Qm...`) for a raw payload, using the sha2-256 multihash. */
export function ipfsCidV0FromBytes(payload: Buffer): string {
  const digest = createHash('sha256').update(payload).digest();
  return encodeBase58btc(Buffer.concat([MULTIHASH_SHA2_256, digest]));
}

/** Hex digest of a payload (used for test fixtures and byte-level checks). */
export function sha256Hex(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Decode a CIDv0 back to its 32-byte SHA-256 digest (issue #93). Inverse of
 * `ipfsCidV0FromBytes`'s multihash wrapping: strips the 2-byte
 * `0x12 0x20` sha2-256 multihash prefix after base58btc-decoding. Throws
 * `InvalidEvidenceHashError` for anything that is not a well-formed CIDv0.
 */
export function decodeCidV0(cid: string): Buffer {
  if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    throw new InvalidEvidenceHashError(`Invalid evidence hash: "${cid}" is not a well-formed CIDv0`);
  }
  const decoded = decodeBase58btc(cid);
  if (decoded.length !== 34 || !decoded.subarray(0, 2).equals(MULTIHASH_SHA2_256)) {
    throw new InvalidEvidenceHashError(
      `Invalid evidence hash: "${cid}" does not decode to a 32-byte sha2-256 multihash`,
    );
  }
  return decoded.subarray(2);
}

/**
 * Whether `value` is a supported evidence hash format (issue #93): CIDv0 or
 * a raw 64-character hex SHA-256 digest. Pure and synchronous -- see
 * `checkEvidenceRetrievable` below for the separate, optional, network-bound
 * availability check (kept apart per this issue's contributor guidance so
 * format validation stays deterministic in tests).
 */
export function isValidEvidenceHash(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
  try {
    decodeCidV0(value);
    return true;
  } catch {
    return false;
  }
}

export interface EvidenceResult {
  /** Content-addressed IPFS CIDv0 (`Qm...`) — value for `ipfs_evidence_hash`. */
  ipfs_evidence_hash: string;
  /** Raw canonical JSON that was hashed (the pinnable payload). */
  canonicalJson: string;
}

/**
 * Deterministically hash any report payload into an evidence hash.
 * Deterministic: identical payloads always yield identical hashes.
 */
export function hashEvidence(payload: unknown): EvidenceResult {
  const serialized = canonicalJson(payload);
  const hash = ipfsCidV0FromBytes(Buffer.from(serialized, 'utf8'));
  return { ipfs_evidence_hash: hash, canonicalJson: serialized };
}

/** Sign the canonical evidence JSON with a provider key (HMAC-SHA256 hex). */
export function signEvidence(payload: unknown, secret: string): string {
  const { canonicalJson: serialized } = hashEvidence(payload);
  return createHmac('sha256', secret).update(serialized).digest('hex');
}

export interface IpfsPinConfig {
  apiUrl: string;
  apiKey: string;
  secretKey: string;
  gateway: string;
}

export interface IpfsUploadResult {
  hash: string;
  gatewayUrl: string;
  pinSize: number;
  timestamp: string;
}

function loadPinConfig(): IpfsPinConfig {
  return {
    apiUrl: process.env.IPFS_API_URL || 'https://api.pinata.cloud',
    apiKey: process.env.IPFS_API_KEY || '',
    secretKey: process.env.IPFS_SECRET_KEY || '',
    gateway: process.env.IPFS_GATEWAY || GATEWAY,
  };
}

/**
 * Hash a payload, upload (pin) it to the configured IPFS provider, and return
 * the evidence hash plus gateway URL. Throws if pinning credentials are
 * missing or the provider rejects the upload.
 */
export async function uploadEvidence(
  payload: unknown,
  config: IpfsPinConfig = loadPinConfig(),
  http: HttpClient = createAxiosHttpClient(),
): Promise<IpfsUploadResult & EvidenceResult> {
  if (!config.apiKey || !config.secretKey) {
    throw new Error('IPFS upload requires IPFS_API_KEY and IPFS_SECRET_KEY');
  }
  const evidence = hashEvidence(payload);
  const { status, data } = await http.post(
    `${config.apiUrl}/pinning/pinJSONToIPFS`,
    {
      pinataContent: JSON.parse(evidence.canonicalJson),
      pinataMetadata: { name: `nbs-oracle-${evidence.ipfs_evidence_hash}` },
    },
    {
      headers: {
        pinata_api_key: config.apiKey,
        pinata_secret_api_key: config.secretKey,
      },
    },
  );

  if (status < 200 || status >= 300) {
    throw new Error(`IPFS upload failed with status ${status}`);
  }

  const result = data as { IpfsHash?: string; PinSize?: number };
  const hash = result.IpfsHash || evidence.ipfs_evidence_hash;
  return {
    hash,
    gatewayUrl: `${config.gateway}${hash}`,
    pinSize: result.PinSize ?? Buffer.byteLength(evidence.canonicalJson, 'utf8'),
    timestamp: new Date().toISOString(),
    ...evidence,
  };
}

/**
 * Optional, bounded IPFS/gateway retrievability check (issue #93). Returns
 * whether `cid` resolves to a 2xx response from the configured gateway
 * within `timeoutMs`; never throws for an unreachable/unavailable gateway,
 * so a caller can decide how to treat "not retrievable" (e.g. warn vs.
 * reject) without a try/catch. Deliberately separate from
 * `isValidEvidenceHash` (format validation is synchronous and
 * network-free; this is not) so tests for one never need to mock the other.
 */
export async function checkEvidenceRetrievable(
  cid: string,
  gateway: string = GATEWAY,
  timeoutMs = 5000,
  http: HttpClient = createAxiosHttpClient(),
): Promise<boolean> {
  try {
    const { status } = await http.get(`${gateway}${cid}`, { timeoutMs });
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}
