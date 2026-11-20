import { createHash } from 'crypto';
import {
  canonicalJson,
  hashEvidence,
  uploadEvidence,
  ipfsCidV0FromBytes,
  encodeBase58btc,
  decodeBase58btc,
  decodeCidV0,
  isValidEvidenceHash,
  checkEvidenceRetrievable,
  sha256Hex,
  InvalidEvidenceHashError,
} from '../ipfs/evidence';
import { MockHttpClient } from './test-helpers';

const FIXTURE = {
  project_id: 'VCS-1234',
  carbon_sequestered: 50000,
};

describe('ipfs evidence hashing', () => {
  it('canonicalJson serializes objects with sorted keys', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('hashEvidence is deterministic for identical payloads', () => {
    const first = hashEvidence(FIXTURE);
    const second = hashEvidence({ ...FIXTURE });
    expect(first.ipfs_evidence_hash).toBe(second.ipfs_evidence_hash);
  });

  it('hashEvidence differs when the payload changes', () => {
    const base = hashEvidence(FIXTURE);
    const changed = hashEvidence({ ...FIXTURE, carbon_sequestered: 1 });
    expect(base.ipfs_evidence_hash).not.toBe(changed.ipfs_evidence_hash);
  });

  it('produces a valid CIDv0 base58btc hash with the Qm prefix', () => {
    const { ipfs_evidence_hash } = hashEvidence(FIXTURE);
    expect(ipfs_evidence_hash).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
  });

  it('encodeBase58btc prefixes leading zero bytes with the zero digit', () => {
    expect(encodeBase58btc(Buffer.from([0x00, 0x00, 0x01]))).toBe('112');
    expect(encodeBase58btc(Buffer.from([0xff]))).toBe('5Q');
  });

  it('matches the canonical IPFS CIDv0 of an empty payload', () => {
    expect(ipfsCidV0FromBytes(Buffer.from('', 'utf8'))).toBe(
      'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n',
    );
  });

  it('decodeBase58btc is the inverse of encodeBase58btc', () => {
    const bytes = Buffer.from([0x12, 0x20, 0xde, 0xad, 0xbe, 0xef]);
    expect(decodeBase58btc(encodeBase58btc(bytes))).toEqual(bytes);
  });
});

describe('evidence hash validation (#93)', () => {
  const digest = createHash('sha256').update('evidence-payload').digest();
  const cid = ipfsCidV0FromBytes(Buffer.from('evidence-payload'));
  const hex = sha256Hex(Buffer.from('evidence-payload'));

  describe('decodeCidV0', () => {
    it('decodes a real CIDv0 back to its 32-byte digest', () => {
      expect(decodeCidV0(cid)).toEqual(digest);
    });

    it('round-trips through hashEvidence -> decodeCidV0', () => {
      const { ipfs_evidence_hash, canonicalJson: serialized } = hashEvidence({ a: 1 });
      const recovered = decodeCidV0(ipfs_evidence_hash);
      const expectedDigest = createHash('sha256').update(serialized, 'utf8').digest();
      expect(recovered).toEqual(expectedDigest);
    });

    it('rejects malformed hex disguised with a Qm-like shape', () => {
      expect(() => decodeCidV0('Qm' + 'z'.repeat(44))).toThrow(InvalidEvidenceHashError);
    });

    it('rejects a CIDv0 of the wrong length', () => {
      expect(() => decodeCidV0(cid.slice(0, -1))).toThrow(InvalidEvidenceHashError);
    });

    it('rejects a non-CID string', () => {
      expect(() => decodeCidV0('not-a-cid')).toThrow(InvalidEvidenceHashError);
    });
  });

  describe('isValidEvidenceHash', () => {
    it('accepts a valid CIDv0', () => {
      expect(isValidEvidenceHash(cid)).toBe(true);
    });

    it('accepts a valid 64-character hex digest', () => {
      expect(isValidEvidenceHash(hex)).toBe(true);
    });

    it('rejects malformed hex', () => {
      expect(isValidEvidenceHash('zz'.repeat(32))).toBe(false);
    });

    it('rejects the wrong digest length', () => {
      expect(isValidEvidenceHash('ab'.repeat(10))).toBe(false);
    });

    it('rejects an unsupported CID version (CIDv1)', () => {
      expect(isValidEvidenceHash('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(false);
    });

    it('rejects a plain, non-evidence-shaped string', () => {
      expect(isValidEvidenceHash('not-an-evidence-hash')).toBe(false);
    });
  });

  describe('checkEvidenceRetrievable (bounded, mocked -- no real network access)', () => {
    it('returns true when the gateway responds with 2xx', async () => {
      const http = new MockHttpClient([{ status: 200, data: {} }]);
      await expect(checkEvidenceRetrievable(cid, 'https://gateway.example/ipfs/', 5000, http)).resolves.toBe(true);
      expect(http.calls[0].url).toBe(`https://gateway.example/ipfs/${cid}`);
    });

    it('returns false when the gateway responds with a non-2xx status', async () => {
      const http = new MockHttpClient([{ status: 404, data: {} }]);
      await expect(checkEvidenceRetrievable(cid, 'https://gateway.example/ipfs/', 5000, http)).resolves.toBe(false);
    });

    it('returns false (does not throw) when the request errors or times out', async () => {
      const http = new MockHttpClient([new Error('timeout')]);
      await expect(checkEvidenceRetrievable(cid, 'https://gateway.example/ipfs/', 5000, http)).resolves.toBe(false);
    });
  });
});

describe('uploadEvidence', () => {
  const config = {
    apiUrl: 'https://api.pinata.cloud',
    apiKey: 'key',
    secretKey: 'secret',
    gateway: 'https://gateway.pinata.cloud/ipfs/',
  };

  it('pins the payload and returns the evidence hash', async () => {
    const http = new MockHttpClient([
      { status: 200, data: { IpfsHash: 'QmPinataHash123', PinSize: 42 } },
    ]);
    const result = await uploadEvidence(FIXTURE, config, http);
    expect(result.hash).toBe('QmPinataHash123');
    expect(result.ipfs_evidence_hash).toBe(hashEvidence(FIXTURE).ipfs_evidence_hash);
    expect(result.gatewayUrl).toContain('QmPinataHash123');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe('https://api.pinata.cloud/pinning/pinJSONToIPFS');
  });

  it('throws when pinning credentials are missing', async () => {
    await expect(
      uploadEvidence(FIXTURE, { ...config, apiKey: '', secretKey: '' }),
    ).rejects.toThrow('IPFS_API_KEY');
  });

  it('throws when the pinning provider rejects the upload', async () => {
    const http = new MockHttpClient([
      { status: 401, data: { error: 'unauthorized' } },
    ]);
    await expect(uploadEvidence(FIXTURE, config, http)).rejects.toThrow(
      'IPFS upload failed',
    );
  });

  it('propagates network errors from the upstream provider', async () => {
    const http = new MockHttpClient([new Error('connection refused')]);
    await expect(uploadEvidence(FIXTURE, config, http)).rejects.toThrow(
      'connection refused',
    );
  });
});
