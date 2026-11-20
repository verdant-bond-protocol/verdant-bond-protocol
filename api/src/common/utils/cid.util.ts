/**
 * Evidence hash / CID encoding for on-chain storage (issue #93).
 *
 * Exactly two formats are defined as supported, both resolving to exactly
 * 32 bytes to match the contract's `ipfs_evidence_hash: BytesN<32>` field
 * (`contracts/oracle-consumer/src/lib.rs`):
 *
 *  - CIDv0: `Qm` + 44 base58btc characters, decoding to the 34-byte
 *    multihash `0x12 0x20 <32-byte SHA-256 digest>`. The 2-byte multihash
 *    prefix is stripped; only the digest is stored on-chain. This is the
 *    only format `hashEvidence()` in `ipfs/evidence.ts` (used by every
 *    provider adapter) ever produces, and the only format
 *    `oracle/validator.ts`'s `validateForOnChain` accepts.
 *  - A raw 64-character hex string (32-byte SHA-256 digest), matching what
 *    `sha256Hex` in `ipfs/evidence.ts` and the existing hex-encoded
 *    `ipfsHash`/`counterEvidenceHash` report fields already use.
 *
 * CIDv1 is deliberately **not** supported: nothing in this codebase's
 * adapters, validators, or IPFS pinning path ever produces one, and a
 * correct general CIDv1 parser needs multibase-prefix and varint-codec
 * handling this system has no use for. A CIDv1-shaped string is one of the
 * "unsupported CID" cases this issue's tests cover -- it is rejected the
 * same as any other malformed input, not partially parsed.
 *
 * Anything that isn't one of the two supported formats -- wrong length,
 * invalid encoding, an unsupported CID version -- is rejected by throwing,
 * rather than silently substituted with a hash of the input string (this
 * function's prior behavior). Nothing in this codebase currently calls
 * `encodeCid`/`decodeCid`/`isValidCid` (confirmed by search), so tightening
 * this contract has zero blast radius on existing callers.
 */

const CIDV0_PREFIX = Buffer.from([0x12, 0x20]);
const DIGEST_LENGTH = 32;

export class InvalidEvidenceReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEvidenceReferenceError';
  }
}

/**
 * Attempts to extract the 32-byte digest from a CIDv0 or raw hex evidence
 * reference. Returns `null` (never throws) for anything else, including a
 * well-formed but unsupported CID version -- pure, synchronous, O(n) in the
 * length of `cid`, no I/O.
 */
function tryExtractDigest(cid: string): Buffer | null {
  if (typeof cid !== 'string' || cid.length === 0) return null;

  if (/^[0-9a-fA-F]{64}$/.test(cid)) {
    return Buffer.from(cid, 'hex');
  }

  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    let decoded: Uint8Array;
    try {
      decoded = base58Decode(cid);
    } catch {
      return null;
    }
    if (decoded.length === 34 && decoded[0] === 0x12 && decoded[1] === 0x20) {
      return Buffer.from(decoded.slice(2));
    }
  }

  return null;
}

/**
 * Encode a supported evidence reference (CIDv0 or raw hex digest) to the
 * 32-byte digest used for on-chain contract storage. Throws
 * `InvalidEvidenceReferenceError` for anything that does not resolve to
 * exactly a 32-byte digest in a supported format -- see the module doc
 * comment above for exactly what is and is not accepted.
 */
export function encodeCid(cid: string): Buffer {
  if (!cid || typeof cid !== 'string') {
    throw new InvalidEvidenceReferenceError('Invalid evidence reference: must be a non-empty string');
  }

  const digest = tryExtractDigest(cid);
  if (!digest || digest.length !== DIGEST_LENGTH) {
    throw new InvalidEvidenceReferenceError(
      `Invalid evidence reference: "${cid}" is not a supported CIDv0 or ` +
      `64-character hex SHA-256 digest`,
    );
  }
  return digest;
}

/**
 * Decode bytes from contract storage back to a CID string.
 * Returns the original CIDv0 (base58) or base32 (CIDv1) string.
 */
export function decodeCid(bytes: Uint8Array): string {
  if (!bytes || bytes.length === 0) {
    return '';
  }

  // Check if it's already a valid CIDv0 multihash (34 bytes: 0x12 0x20 + 32-byte digest)
  if (bytes.length === 34 && bytes[0] === 0x12 && bytes[1] === 0x20) {
    return base58Encode(bytes);
  }

  // Check if it's a valid CIDv1 (starts with 0x01 + codec + multihash)
  if (bytes.length > 2 && bytes[0] === 0x01) {
    return base32Encode(bytes);
  }

  // The on-chain evidence hash is stored as a bare 32-byte digest (see
  // `encodeCid`, issue #93) -- reconstruct the CIDv0 it came from by
  // re-prefixing the sha2-256 multihash header.
  if (bytes.length === DIGEST_LENGTH) {
    return base58Encode(Buffer.concat([CIDV0_PREFIX, bytes]));
  }

  // For other lengths, try base32 encoding
  return base32Encode(bytes);
}

/**
 * Validate whether `cid` is a supported evidence reference (issue #93):
 * CIDv0 or a raw 64-character hex SHA-256 digest -- i.e. whether
 * `encodeCid(cid)` would succeed. Pure and synchronous; does not check
 * retrievability (see `docs/oracle-design.md`'s evidence section for why
 * that is a deliberately separate, optional, network-dependent check).
 */
export function isValidCid(cid: string): boolean {
  return tryExtractDigest(cid) !== null;
}

// Base58 encoding/decoding (Bitcoin alphabet)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer: Uint8Array): string {
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    let carry = buffer[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let result = '';
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    result += BASE58_ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]];
  }
  return result;
}

function base58Decode(str: string): Uint8Array {
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const c = BASE58_ALPHABET.indexOf(str[i]);
    if (c < 0) {
      throw new Error(`Invalid base58 character: ${str[i]}`);
    }
    let carry = c;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (let i = 0; i < str.length && str[i] === BASE58_ALPHABET[0]; i++) {
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

// Base32 encoding/decoding (RFC 4648)
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}