import { z } from 'zod';
import { signEvidence } from '../ipfs/evidence';

/**
 * Oracle signing-key rotation with overlapping validity windows (#447).
 *
 * An oracle manifest is signed with an HMAC secret and stamped with the
 * `signer_public_key` that produced it. Rotating that key is a two-phase
 * operation rather than an instant switch-over:
 *
 *   1. A new key is introduced and becomes valid at `validFromMs`.
 *   2. The previous key is kept valid until its `validUntilMs`, which is set
 *      *after* the new key's `validFromMs` so the two windows overlap.
 *
 * During the overlap window both keys verify, so reports signed moments
 * before a rotation (and still in flight to the verifier) are accepted while
 * new reports are signed with the freshly rotated key. A key that is past its
 * `validUntilMs` (or before its `validFromMs`) never verifies, which prevents
 * unlimited key lifetimes and bounded replay of a retired key.
 *
 * Keys are identified by `keyId` (the value written into
 * `signer_public_key`); the shared `secret` never leaves the oracle process.
 */

export const OracleKeySchema = z
  .object({
    keyId: z.string().min(1),
    secret: z.string().min(1),
    validFromMs: z.number().int().nonnegative(),
    validUntilMs: z.number().int().nonnegative().nullable().optional(),
  })
  .refine(
    (key) => key.validUntilMs == null || key.validUntilMs > key.validFromMs,
    { message: 'validUntilMs must be after validFromMs' },
  );

export type OracleKey = z.infer<typeof OracleKeySchema>;

export interface SignedOraclePayload {
  keyId: string;
  /** Epoch milliseconds at which the payload was signed; selects the key window. */
  timestampMs: number;
  signature: string;
}

export interface VerifyResult {
  valid: boolean;
  keyId?: string;
  error?: string;
}

/** Raised when two keys in a keyring declare the same `keyId`. */
export class DuplicateKeyIdError extends Error {
  constructor(keyId: string) {
    super(`Duplicate oracle key id: ${keyId}`);
    this.name = 'DuplicateKeyIdError';
  }
}

function isKeyValidAt(key: OracleKey, timestampMs: number): boolean {
  if (timestampMs < key.validFromMs) return false;
  if (key.validUntilMs != null && timestampMs >= key.validUntilMs) return false;
  return true;
}

/**
 * A set of oracle signing keys with per-key validity windows. Keys may
 * overlap; a signature is accepted if it was produced by any key that was
 * valid at the signature's timestamp.
 */
export class OracleKeyring {
  private readonly keys: OracleKey[];

  constructor(keys: OracleKey[] = []) {
    const parsed = keys.map((key) => OracleKeySchema.parse(key));
    const seen = new Set<string>();
    for (const key of parsed) {
      if (seen.has(key.keyId)) throw new DuplicateKeyIdError(key.keyId);
      seen.add(key.keyId);
    }
    this.keys = parsed;
  }

  /** All keys, including retired ones whose window has closed. */
  list(): OracleKey[] {
    return [...this.keys];
  }

  /** Keys whose validity window contains `timestampMs`. */
  keysValidAt(timestampMs: number): OracleKey[] {
    return this.keys.filter((key) => isKeyValidAt(key, timestampMs));
  }

  /** The single key valid at `timestampMs`, or null when none / more than one. */
  resolveKey(timestampMs: number): OracleKey | null {
    const valid = this.keysValidAt(timestampMs);
    return valid.length === 1 ? valid[0] : valid.length > 0 ? valid[valid.length - 1] : null;
  }

  /**
   * Add a key. Returns a new keyring so rotation is explicit and immutable,
   * which keeps verification deterministic across callers.
   */
  withKey(key: OracleKey): OracleKeyring {
    return new OracleKeyring([...this.keys, key]);
  }

  /**
   * Rotate to `newKey`, extending the newest previously-active key's window
   * so it remains valid for `overlapMs` past the new key's `validFromMs`.
   *
   * Returns the new keyring plus the closed-out windows, so operators can log
   * exactly which key was extended and until when.
   */
  rotateKey(
    newKey: OracleKey,
    overlapMs: number,
  ): { keyring: OracleKeyring; extended: OracleKey[] } {
    if (overlapMs < 0) {
      throw new Error('overlapMs must be non-negative');
    }
    const parsedNew = OracleKeySchema.parse(newKey);
    const overlapUntil = parsedNew.validFromMs + overlapMs;

    const extended: OracleKey[] = [];
    const rotated = this.keys.map((key) => {
      if (key.validFromMs > parsedNew.validFromMs) return key;
      // Already closed at or before the overlap end: nothing to re-bound.
      if (key.validUntilMs != null && key.validUntilMs <= overlapUntil) return key;
      const next: OracleKey = { ...key, validUntilMs: overlapUntil };
      extended.push(next);
      return next;
    });

    return {
      keyring: new OracleKeyring([...rotated, parsedNew]),
      extended,
    };
  }

  /**
   * Sign a payload with the key valid at `timestampMs`. Throws when no key is
   * valid at that instant, so a rotation gap cannot silently unsigned reports.
   */
  sign(payload: unknown, timestampMs: number, keyId?: string): SignedOraclePayload {
    const candidates = this.keysValidAt(timestampMs);
    const key = keyId
      ? candidates.find((candidate) => candidate.keyId === keyId)
      : this.resolveKey(timestampMs);
    if (!key) {
      throw new Error(
        `No oracle key valid at ${timestampMs}${keyId ? ` with id ${keyId}` : ''}`,
      );
    }
    return {
      keyId: key.keyId,
      timestampMs,
      signature: signEvidence(payload, key.secret),
    };
  }

  /** Verify a signed payload against the key that claims to have signed it. */
  verify(payload: unknown, signed: SignedOraclePayload): VerifyResult {
    const key = this.keys.find((candidate) => candidate.keyId === signed.keyId);
    if (!key) {
      return { valid: false, error: `Unknown oracle key id: ${signed.keyId}` };
    }
    if (!isKeyValidAt(key, signed.timestampMs)) {
      return {
        valid: false,
        keyId: key.keyId,
        error: `Key ${key.keyId} was not valid at ${signed.timestampMs}`,
      };
    }
    const expected = signEvidence(payload, key.secret);
    if (expected !== signed.signature) {
      return { valid: false, keyId: key.keyId, error: 'Signature verification failed' };
    }
    return { valid: true, keyId: key.keyId };
  }

  /**
   * Verify that at least one of `signatures` is valid for `payload`. This is
   * the overlap-window entry point: a report signed by the retiring key and a
   * report signed by the new key are both accepted while their windows
   * intersect.
   */
  verifyAny(payload: unknown, signatures: SignedOraclePayload[]): VerifyResult {
    if (signatures.length === 0) {
      return { valid: false, error: 'No signatures supplied' };
    }
    const errors: string[] = [];
    for (const signed of signatures) {
      const result = this.verify(payload, signed);
      if (result.valid) return result;
      if (result.error) errors.push(result.error);
    }
    return { valid: false, error: errors.join('; ') };
  }
}

/** Epoch-ms bounds of the intersection of two keys' validity windows, or null. */
export function overlapWindow(
  a: OracleKey,
  b: OracleKey,
): { startMs: number; endMs: number } | null {
  const startMs = Math.max(a.validFromMs, b.validFromMs);
  const aEnd = a.validUntilMs ?? Number.POSITIVE_INFINITY;
  const bEnd = b.validUntilMs ?? Number.POSITIVE_INFINITY;
  const endMs = Math.min(aEnd, bEnd);
  if (endMs <= startMs) return null;
  return {
    startMs,
    endMs: Number.isFinite(endMs) ? endMs : Number.POSITIVE_INFINITY,
  };
}
