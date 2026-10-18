/**
 * Cryptographic verification of imported external evidence (#393):
 * normal, failure, retry and authorization paths, plus OracleService wiring.
 */
import { createHash } from 'crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import {
  digestMatchesReference,
  fetchAndVerifyEvidence,
  parseDelegatedSigners,
  resolveSignatureMode,
  signManifestEd25519,
  verifyEd25519Manifest,
} from './evidence-verification';
import { canonicalJson, signEvidence, DEFAULT_MANIFEST_SECRET } from './manifest-verification';
import { OracleService } from './oracle.service';

// CIDv0 = base58btc(0x12 0x20 || sha256), as produced by ipfs/evidence.ts.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function toCidV0(digest: Buffer): string {
  const bytes = Buffer.concat([Buffer.from([0x12, 0x20]), digest]);
  let n = BigInt('0x' + bytes.toString('hex'));
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

const provider = Keypair.random();
const delegate = Keypair.random();
const stranger = Keypair.random();
const NOW = Date.parse('2026-10-01T00:00:00Z');

const evidenceDoc = { project_id: 'VCS-1234', readings: [1, 2, 3], site: 'mangrove-7' };
const evidenceBytes = Buffer.from(JSON.stringify(evidenceDoc, null, 2)); // pretty, not canonical
const evidenceCid = toCidV0(sha256(canonicalJson(evidenceDoc)));
const rawBytes = Buffer.from('%PDF-1.7 survey report');
const rawCid = toCidV0(sha256(rawBytes));

const baseManifest = {
  project_id: 'VCS-1234',
  provider: 'SatelliteProcessor',
  methodology: 'VM0003',
  period_start: '2023-11-14',
  period_end: '2023-11-15',
  carbon_sequestered: 1200,
  confidence: 0.85,
  raw_observations: { count: 5 },
  transformation_parameters: { factor: 1.0 },
  generated_at: '2026-09-30T12:00:00Z',
};

describe('verifyEd25519Manifest', () => {
  it('normal path: accepts a manifest signed by the provider itself', () => {
    const manifest = signManifestEd25519(baseManifest, provider);
    expect(verifyEd25519Manifest(manifest, provider.publicKey(), { now: NOW })).toEqual({ valid: true });
  });

  it('accepts base64 signatures as well as hex', () => {
    const manifest = signManifestEd25519(baseManifest, provider);
    const b64 = { ...manifest, signature: Buffer.from(manifest.signature, 'hex').toString('base64') };
    expect(verifyEd25519Manifest(b64, provider.publicKey(), { now: NOW }).valid).toBe(true);
  });

  it('failure path: any tampered field invalidates the signature', () => {
    const manifest = signManifestEd25519(baseManifest, provider);
    for (const tampered of [
      { ...manifest, carbon_sequestered: 1201 },
      { ...manifest, raw_observations: { count: 6 } },
      { ...manifest, period_end: '2023-11-16' },
    ]) {
      expect(verifyEd25519Manifest(tampered, provider.publicKey(), { now: NOW }).code).toBe('SIGNATURE_INVALID');
    }
  });

  it('failure path: rejects malformed signatures and non-Stellar signer keys', () => {
    const manifest = signManifestEd25519(baseManifest, provider);
    expect(verifyEd25519Manifest({ ...manifest, signature: 'abc' }, provider.publicKey(), { now: NOW }).code)
      .toBe('SIGNATURE_MALFORMED');
    expect(
      verifyEd25519Manifest({ ...manifest, signer_public_key: 'VERDANT_ORACLE_KEY_V1' }, 'VERDANT_ORACLE_KEY_V1', { now: NOW }).code,
    ).toBe('SIGNER_INVALID');
    expect(verifyEd25519Manifest({ ...manifest, confidence: 2 }, provider.publicKey(), { now: NOW }).code)
      .toBe('SCHEMA_INVALID');
  });

  it('authorization path: a valid signature from a key that is not the provider is rejected', () => {
    const manifest = signManifestEd25519(baseManifest, stranger);
    expect(verifyEd25519Manifest(manifest, provider.publicKey(), { now: NOW }).code).toBe('SIGNER_UNTRUSTED');
  });

  it('authorization path: delegated signers are honoured only for their provider', () => {
    const manifest = signManifestEd25519(baseManifest, delegate);
    const delegatedSigners = new Map([[provider.publicKey(), new Set([delegate.publicKey()])]]);
    expect(verifyEd25519Manifest(manifest, provider.publicKey(), { now: NOW, delegatedSigners }).valid).toBe(true);
    expect(verifyEd25519Manifest(manifest, stranger.publicKey(), { now: NOW, delegatedSigners }).code)
      .toBe('SIGNER_UNTRUSTED');
  });

  it('a spoofed provider header cannot reuse another provider\'s manifest', () => {
    // Attacker sends x-provider-address of `stranger` with provider's manifest.
    const manifest = signManifestEd25519(baseManifest, provider);
    expect(verifyEd25519Manifest(manifest, stranger.publicKey(), { now: NOW }).code).toBe('SIGNER_UNTRUSTED');
  });

  it('rejects manifests from the future and, when configured, expired ones', () => {
    const future = signManifestEd25519({ ...baseManifest, generated_at: '2026-10-01T01:00:00Z' }, provider);
    expect(verifyEd25519Manifest(future, provider.publicKey(), { now: NOW }).code).toBe('GENERATED_IN_FUTURE');
    const skewed = signManifestEd25519({ ...baseManifest, generated_at: '2026-10-01T00:04:00Z' }, provider);
    expect(verifyEd25519Manifest(skewed, provider.publicKey(), { now: NOW }).valid).toBe(true);
    const old = signManifestEd25519(baseManifest, provider);
    expect(verifyEd25519Manifest(old, provider.publicKey(), { now: NOW, maxAgeSeconds: 3600 }).code).toBe('MANIFEST_EXPIRED');
  });

  it('binds the signature to the anchored evidence when evidence_hash is signed', () => {
    const manifest = signManifestEd25519({ ...baseManifest, evidence_hash: evidenceCid }, provider);
    expect(verifyEd25519Manifest(manifest, provider.publicKey(), { now: NOW, evidenceHash: evidenceCid }).valid).toBe(true);
    expect(verifyEd25519Manifest(manifest, provider.publicKey(), { now: NOW, evidenceHash: rawCid }).code)
      .toBe('EVIDENCE_BINDING_MISMATCH');
  });
});

describe('parseDelegatedSigners / resolveSignatureMode', () => {
  it('parses valid entries and fails closed on garbage', () => {
    const raw = JSON.stringify({ [provider.publicKey()]: [delegate.publicKey(), 'not-a-key'], junk: [delegate.publicKey()] });
    const parsed = parseDelegatedSigners(raw);
    expect([...parsed.keys()]).toEqual([provider.publicKey()]);
    expect([...parsed.get(provider.publicKey())!]).toEqual([delegate.publicKey()]);
    expect(parseDelegatedSigners('{not json').size).toBe(0);
    expect(parseDelegatedSigners('[]').size).toBe(0);
  });

  it('defaults to legacy for unknown modes', () => {
    expect(resolveSignatureMode(undefined)).toBe('legacy');
    expect(resolveSignatureMode('strict-ish')).toBe('legacy');
    expect(resolveSignatureMode('required')).toBe('required');
  });
});

describe('digestMatchesReference', () => {
  it('matches raw bytes, canonical JSON, and hex digests', () => {
    expect(digestMatchesReference(rawBytes, rawCid)).toBe(true);
    expect(digestMatchesReference(evidenceBytes, evidenceCid)).toBe(true);
    expect(digestMatchesReference(rawBytes, sha256(rawBytes).toString('hex'))).toBe(true);
  });

  it('rejects substituted content', () => {
    expect(digestMatchesReference(Buffer.from('%PDF-1.7 forged'), rawCid)).toBe(false);
    expect(digestMatchesReference(Buffer.from(JSON.stringify({ ...evidenceDoc, readings: [9] })), evidenceCid)).toBe(false);
  });
});

function response(status: number, body: Buffer = Buffer.alloc(0), headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

describe('fetchAndVerifyEvidence', () => {
  const opts = (fetchImpl: jest.Mock, extra = {}) => ({
    gateway: 'https://gw.example/ipfs/',
    timeoutMs: 1000,
    maxAttempts: 3,
    maxBytes: 1024,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: jest.fn().mockResolvedValue(undefined),
    ...extra,
  });

  it('normal path: fetches once and verifies the digest', async () => {
    const f = jest.fn().mockResolvedValue(response(200, rawBytes));
    await expect(fetchAndVerifyEvidence(rawCid, opts(f))).resolves.toEqual({ valid: true, attempts: 1 });
    expect(f).toHaveBeenCalledWith(`https://gw.example/ipfs/${rawCid}`, expect.anything());
  });

  it('retry path: transient 503s and network errors are retried with backoff', async () => {
    const f = jest
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(response(200, rawBytes));
    const o = opts(f);
    await expect(fetchAndVerifyEvidence(rawCid, o)).resolves.toEqual({ valid: true, attempts: 3 });
    expect(o.sleep.mock.calls).toEqual([[250], [500]]);
  });

  it('retry path: gives up after maxAttempts with the last error', async () => {
    const f = jest.fn().mockResolvedValue(response(502));
    const result = await fetchAndVerifyEvidence(rawCid, opts(f));
    expect(result).toMatchObject({ valid: false, code: 'NOT_RETRIEVABLE', attempts: 3 });
    expect(result.error).toContain('status 502');
  });

  it('failure path: a gateway serving different bytes is rejected without retrying', async () => {
    const f = jest.fn().mockResolvedValue(response(200, Buffer.from('%PDF-1.7 forged')));
    await expect(fetchAndVerifyEvidence(rawCid, opts(f))).resolves.toMatchObject({ code: 'DIGEST_MISMATCH', attempts: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('failure path: 404 is final, not retried', async () => {
    const f = jest.fn().mockResolvedValue(response(404));
    await expect(fetchAndVerifyEvidence(rawCid, opts(f))).resolves.toMatchObject({ code: 'NOT_RETRIEVABLE', attempts: 1 });
  });

  it('failure path: oversize evidence is refused (declared or actual size)', async () => {
    const declared = jest.fn().mockResolvedValue(response(200, rawBytes, { 'content-length': '999999' }));
    await expect(fetchAndVerifyEvidence(rawCid, opts(declared))).resolves.toMatchObject({ code: 'TOO_LARGE' });
    const actual = jest.fn().mockResolvedValue(response(200, Buffer.alloc(2048)));
    await expect(fetchAndVerifyEvidence(rawCid, opts(actual))).resolves.toMatchObject({ code: 'TOO_LARGE' });
  });
});

describe('OracleService evidence wiring (#393)', () => {
  const ENV_KEYS = [
    'ORACLE_EVIDENCE_SIGNATURE_MODE',
    'ORACLE_EVIDENCE_VERIFY_CONTENT',
    'ORACLE_EVIDENCE_VERIFY_RETRIEVABILITY',
    'ORACLE_EVIDENCE_DELEGATED_SIGNERS',
    'ORACLE_EVIDENCE_FETCH_ATTEMPTS',
  ];
  const saved: Record<string, string | undefined> = {};
  const realFetch = global.fetch;
  let service: OracleService;
  let ipfs: { uploadJson: jest.Mock };
  let contract: { invokeContractMethod: jest.Mock };

  const dto = {
    projectId: 'VCS-1234',
    periodStart: 1699920000, // 2023-11-14
    periodEnd: 1700006400, // 2023-11-15
    carbonSequestered: 1200,
    methodology: 'VM0003',
  };
  const freshManifest = (extra = {}, kp = provider) =>
    signManifestEd25519({ ...baseManifest, generated_at: new Date().toISOString(), ...extra }, kp);
  const legacyManifest = () => {
    const unsigned = { ...baseManifest, signer_public_key: 'VERDANT_ORACLE_KEY_V1' };
    return { ...unsigned, signature: signEvidence(unsigned, DEFAULT_MANIFEST_SECRET) };
  };

  beforeEach(() => {
    ENV_KEYS.forEach((k) => {
      saved[k] = process.env[k];
      delete process.env[k];
    });
    ipfs = { uploadJson: jest.fn().mockResolvedValue({ hash: rawCid }) };
    const { nativeToScVal } = jest.requireActual('@stellar/stellar-sdk');
    contract = { invokeContractMethod: jest.fn().mockResolvedValue({ result: nativeToScVal(BigInt(1), { type: 'u64' }) }) };
    service = new OracleService(
      contract as any,
      ipfs as any,
      { getKeypairFromSecret: () => provider } as any,
      {} as any,
      { del: jest.fn() } as any,
      { adminSecret: () => 'S' } as any,
      { getOracleConsumerAddress: () => 'CORACLE' } as any,
    );
    jest.spyOn(service as any, 'getAdminSecret').mockReturnValue('S');
  });
  afterEach(() => {
    ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
    global.fetch = realFetch;
  });

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      return ((e as UnprocessableEntityException).getResponse() as any).evidenceCode;
    }
    throw new Error('expected rejection');
  };

  it('legacy mode (default) still accepts HMAC manifests: existing contract preserved', async () => {
    await expect(service.submitReport({ ...dto, manifest: legacyManifest() } as any, provider.publicKey())).resolves.toBeDefined();
  });

  it('accepts an ed25519 manifest from the provider in every mode', async () => {
    for (const mode of ['legacy', 'ed25519', 'required']) {
      process.env.ORACLE_EVIDENCE_SIGNATURE_MODE = mode;
      await expect(service.submitReport({ ...dto, manifest: freshManifest() } as any, provider.publicKey())).resolves.toBeDefined();
    }
  });

  it('rejects an untrusted signer before anything is pinned or submitted', async () => {
    const code = await codeOf(service.submitReport({ ...dto, manifest: freshManifest({}, stranger) } as any, provider.publicKey()));
    expect(code).toBe('SIGNER_UNTRUSTED');
    expect(ipfs.uploadJson).not.toHaveBeenCalled();
    expect(contract.invokeContractMethod).not.toHaveBeenCalled();
  });

  it('honours delegated signers from configuration', async () => {
    process.env.ORACLE_EVIDENCE_DELEGATED_SIGNERS = JSON.stringify({ [provider.publicKey()]: [delegate.publicKey()] });
    await expect(
      service.submitReport({ ...dto, manifest: freshManifest({}, delegate) } as any, provider.publicKey()),
    ).resolves.toBeDefined();
  });

  it('ed25519 mode rejects legacy HMAC manifests; required mode rejects reports without one', async () => {
    process.env.ORACLE_EVIDENCE_SIGNATURE_MODE = 'ed25519';
    expect(await codeOf(service.submitReport({ ...dto, manifest: legacyManifest() } as any, provider.publicKey()))).toBe('LEGACY_SCHEME_REJECTED');
    await expect(service.submitReport(dto as any, provider.publicKey())).resolves.toBeDefined();

    process.env.ORACLE_EVIDENCE_SIGNATURE_MODE = 'required';
    expect(await codeOf(service.submitReport(dto as any, provider.publicKey()))).toBe('MANIFEST_REQUIRED');
  });

  it('content verification rejects substituted evidence before the IPFS upload', async () => {
    process.env.ORACLE_EVIDENCE_VERIFY_CONTENT = 'true';
    global.fetch = jest.fn().mockResolvedValue(response(200, Buffer.from('%PDF-1.7 forged'))) as any;
    expect(await codeOf(service.submitReport({ ...dto, evidenceHash: rawCid } as any, provider.publicKey()))).toBe('DIGEST_MISMATCH');
    expect(ipfs.uploadJson).not.toHaveBeenCalled();
  });

  it('content verification accepts genuine evidence after a transient gateway failure', async () => {
    process.env.ORACLE_EVIDENCE_VERIFY_CONTENT = 'true';
    process.env.ORACLE_EVIDENCE_FETCH_ATTEMPTS = '2';
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, rawBytes)) as any;
    await expect(service.submitReport({ ...dto, evidenceHash: rawCid } as any, provider.publicKey())).resolves.toBeDefined();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('a signed evidence binding must match the anchored evidence reference', async () => {
    const manifest = freshManifest({ evidence_hash: evidenceCid });
    expect(
      await codeOf(service.submitReport({ ...dto, evidenceHash: rawCid, manifest } as any, provider.publicKey())),
    ).toBe('EVIDENCE_BINDING_MISMATCH');
  });
});
