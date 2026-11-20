import { encodeCid, decodeCid, isValidCid, InvalidEvidenceReferenceError } from './cid.util';

// sha256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
// Independently computed via `crypto.createHash('sha256')` + base58btc encoding
// of the sha2-256 multihash (0x12 0x20 <digest>), not copied from any library.
const KNOWN_DIGEST_HEX = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
const KNOWN_CIDV0 = 'QmaozNR7DZHQK1ZcU9p7QdrshMvXqWK6gpu5rmrkPdT3L4';

describe('cid.util (issue #93)', () => {
  describe('encodeCid', () => {
    it('decodes a valid CIDv0 to its 32-byte digest', () => {
      const digest = encodeCid(KNOWN_CIDV0);
      expect(digest.length).toBe(32);
      expect(digest.toString('hex')).toBe(KNOWN_DIGEST_HEX);
    });

    it('decodes a valid 64-character hex digest as-is', () => {
      const digest = encodeCid(KNOWN_DIGEST_HEX);
      expect(digest.length).toBe(32);
      expect(digest.toString('hex')).toBe(KNOWN_DIGEST_HEX);
    });

    it('accepts uppercase hex', () => {
      const digest = encodeCid(KNOWN_DIGEST_HEX.toUpperCase());
      expect(digest.toString('hex')).toBe(KNOWN_DIGEST_HEX);
    });

    it('rejects a malformed hex string (invalid characters)', () => {
      expect(() => encodeCid('g'.repeat(64))).toThrow(InvalidEvidenceReferenceError);
    });

    it('rejects a hex string of the wrong length (short)', () => {
      expect(() => encodeCid('ab'.repeat(16))).toThrow(InvalidEvidenceReferenceError);
    });

    it('rejects a hex string of the wrong length (long)', () => {
      expect(() => encodeCid('ab'.repeat(40))).toThrow(InvalidEvidenceReferenceError);
    });

    it('rejects a CIDv0-shaped string with an invalid base58 character', () => {
      // '0', 'O', 'I', 'l' are excluded from the base58btc alphabet.
      const malformed = 'Qm' + '0'.repeat(44);
      expect(() => encodeCid(malformed)).toThrow(InvalidEvidenceReferenceError);
    });

    it('rejects a CIDv0-shaped string of the wrong length', () => {
      expect(() => encodeCid(KNOWN_CIDV0.slice(0, -1))).toThrow(InvalidEvidenceReferenceError);
    });

    it('rejects an unsupported CID version (CIDv1)', () => {
      // A real CIDv1 (base32, multibase-prefixed) -- a well-formed reference
      // in a version this codebase does not support, not a malformed string.
      const cidv1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
      expect(() => encodeCid(cidv1)).toThrow(InvalidEvidenceReferenceError);
    });

    it('rejects an empty string', () => {
      expect(() => encodeCid('')).toThrow(InvalidEvidenceReferenceError);
    });

    it('rejects a plain, non-evidence-shaped string', () => {
      expect(() => encodeCid('not-an-evidence-hash')).toThrow(InvalidEvidenceReferenceError);
    });

    it('never falls back to hashing the input string for unsupported input', () => {
      // The old behavior silently returned sha256('not-a-real-cid'); the new
      // behavior must throw instead, so no such digest is ever produced.
      let threw = false;
      try {
        encodeCid('not-a-real-cid');
      } catch (error) {
        threw = true;
        expect(error).toBeInstanceOf(InvalidEvidenceReferenceError);
      }
      expect(threw).toBe(true);
    });
  });

  describe('round-trip (CIDv0 <-> digest)', () => {
    it('encodeCid then decodeCid reproduces the original CIDv0', () => {
      const digest = encodeCid(KNOWN_CIDV0);
      expect(decodeCid(digest)).toBe(KNOWN_CIDV0);
    });

    it('round-trips for an arbitrary payload digest, not just the fixture', () => {
      const arbitrary = Buffer.from('ff'.repeat(32), 'hex');
      const cid = decodeCid(arbitrary);
      expect(encodeCid(cid)).toEqual(arbitrary);
    });
  });

  describe('isValidCid', () => {
    it('accepts a valid CIDv0', () => {
      expect(isValidCid(KNOWN_CIDV0)).toBe(true);
    });

    it('accepts a valid hex digest', () => {
      expect(isValidCid(KNOWN_DIGEST_HEX)).toBe(true);
    });

    it('rejects malformed hex', () => {
      expect(isValidCid('zz'.repeat(32))).toBe(false);
    });

    it('rejects the wrong digest length', () => {
      expect(isValidCid('ab'.repeat(10))).toBe(false);
    });

    it('rejects an unsupported CID version', () => {
      expect(isValidCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(false);
    });

    it('rejects non-string input without throwing', () => {
      expect(isValidCid(undefined as unknown as string)).toBe(false);
      expect(isValidCid(null as unknown as string)).toBe(false);
    });
  });
});
