import {
  ArtifactInput,
  ReleaseManifest,
  ReleaseManifestError,
  ReleaseProvenance,
  buildManifest,
  serialiseManifest,
  sha256Hex,
  signManifest,
  verifyManifest,
} from './release-artifact-manifest';

const provenance: ReleaseProvenance = {
  commit: '9cf19a2a1b2c3d4e5f60718293a4b5c6d7e8f901',
  toolchain: { node: 'v20.11.0', rust: '1.97.1' },
  lockfiles: { 'api/package-lock.json': 'a'.repeat(64), 'contracts/Cargo.lock': 'b'.repeat(64) },
};

const files: ArtifactInput[] = [
  { path: 'contracts/nbbs_bond_issuer.wasm', content: Buffer.from('wasm-bond-issuer') },
  { path: 'api/dist/main.js', content: Buffer.from('console.log("api")') },
  { path: 'contracts/nbbs_coupon_engine.wasm', content: Buffer.from('wasm-coupon-engine') },
];

const reader = (set: ArtifactInput[]) => {
  const byPath = new Map(set.map((f) => [f.path, f.content]));
  return {
    present: [...byPath.keys()],
    read: async (path: string) => {
      const content = byPath.get(path);
      if (!content) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
};

describe('release artifact manifest (#538)', () => {
  describe('normal path', () => {
    it('is deterministic regardless of input order', () => {
      const a = buildManifest('v1.4.0', provenance, files);
      const b = buildManifest('v1.4.0', provenance, [...files].reverse());

      expect(serialiseManifest(a)).toBe(serialiseManifest(b));
      expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(a.artifacts.map((x) => x.path)).toEqual([
        'api/dist/main.js',
        'contracts/nbbs_bond_issuer.wasm',
        'contracts/nbbs_coupon_engine.wasm',
      ]);
      expect(a.artifacts[0]).toEqual({ path: 'api/dist/main.js', size: 18, sha256: sha256Hex('console.log("api")') });
    });

    it('verifies a matching rebuild', async () => {
      const manifest = buildManifest('v1.4.0', provenance, files);
      const { present, read } = reader(files);
      const report = await verifyManifest(manifest, present, read, { expectedProvenance: provenance });

      expect(report).toMatchObject({ ok: true, retryable: false, digestValid: true, signature: 'missing' });
    });

    it('round-trips through its serialised form', async () => {
      const manifest = JSON.parse(serialiseManifest(buildManifest('v1.4.0', provenance, files))) as ReleaseManifest;
      const { present, read } = reader(files);
      expect((await verifyManifest(manifest, present, read)).ok).toBe(true);
    });
  });

  describe('failure path', () => {
    it('reports every discrepancy at once', async () => {
      const manifest = buildManifest('v1.4.0', provenance, files);
      const rebuilt: ArtifactInput[] = [
        { path: 'api/dist/main.js', content: Buffer.from('console.log("tampered")') },
        { path: 'contracts/nbbs_bond_issuer.wasm', content: Buffer.from('wasm-bond-issuer') },
        { path: 'contracts/extra.wasm', content: Buffer.from('?') },
      ];
      const { present, read } = reader(rebuilt);
      const report = await verifyManifest(manifest, present, read, {
        expectedProvenance: { ...provenance, toolchain: { node: 'v22.0.0', rust: '1.97.1' } },
      });

      expect(report.ok).toBe(false);
      expect(report.retryable).toBe(false);
      expect(report.missing).toEqual(['contracts/nbbs_coupon_engine.wasm']);
      expect(report.unexpected).toEqual(['contracts/extra.wasm']);
      expect(report.mismatched).toEqual([expect.objectContaining({ path: 'api/dist/main.js' })]);
      expect(report.provenanceDrift).toEqual([{ field: 'toolchain.node', expected: 'v22.0.0', actual: 'v20.11.0' }]);
    });

    it('detects a manifest edited after it was built', async () => {
      const manifest = buildManifest('v1.4.0', provenance, files);
      const forged = { ...manifest, artifacts: manifest.artifacts.map((a) => ({ ...a, sha256: sha256Hex('evil') })) };
      const { present, read } = reader(files);
      const report = await verifyManifest(forged, present, read);
      expect(report.digestValid).toBe(false);
      expect(report.ok).toBe(false);
    });

    it('rejects unsafe or duplicate inputs', () => {
      expect(() => buildManifest('v1', provenance, [{ path: '../etc/passwd', content: Buffer.from('') }])).toThrow(
        ReleaseManifestError,
      );
      expect(() => buildManifest('v1', provenance, [{ path: '/abs.wasm', content: Buffer.from('') }])).toThrow(
        ReleaseManifestError,
      );
      expect(() =>
        buildManifest('v1', provenance, [
          { path: 'a.wasm', content: Buffer.from('1') },
          { path: './a.wasm', content: Buffer.from('2') },
        ]),
      ).toThrow(/Duplicate/);
      expect(() => buildManifest('v1', { ...provenance, commit: 'main' }, files)).toThrow(/git sha/);
      expect(() => buildManifest('v1', provenance, [])).toThrow(/at least one/);
    });
  });

  describe('retry path', () => {
    it('marks a run that only failed to read artifacts as retryable', async () => {
      const manifest = buildManifest('v1.4.0', provenance, files);
      const { present } = reader(files);
      let flaky = true;
      const read = async (path: string) => {
        if (flaky && path.endsWith('.js')) throw new Error('EBUSY');
        return files.find((f) => f.path === path)!.content;
      };

      const first = await verifyManifest(manifest, present, read);
      expect(first).toMatchObject({ ok: false, retryable: true, unreadable: [{ path: 'api/dist/main.js', error: 'EBUSY' }] });

      flaky = false;
      expect((await verifyManifest(manifest, present, read)).ok).toBe(true);
    });
  });

  describe('authorization path', () => {
    const trustedKeys = { 'release-2026': 'release-secret' };

    it('accepts a manifest signed by a trusted release key', async () => {
      const signed = signManifest(buildManifest('v1.4.0', provenance, files), 'release-2026', 'release-secret');
      const { present, read } = reader(files);
      expect(await verifyManifest(signed, present, read, { trustedKeys })).toMatchObject({ ok: true, signature: 'valid' });
    });

    it('rejects unsigned, unknown-key and wrong-secret manifests when keys are configured', async () => {
      const manifest = buildManifest('v1.4.0', provenance, files);
      const { present, read } = reader(files);

      expect(await verifyManifest(manifest, present, read, { trustedKeys })).toMatchObject({ ok: false, signature: 'missing' });
      expect(
        await verifyManifest(signManifest(manifest, 'other', 'release-secret'), present, read, { trustedKeys }),
      ).toMatchObject({ ok: false, signature: 'unknown_key' });
      expect(
        await verifyManifest(signManifest(manifest, 'release-2026', 'guess'), present, read, { trustedKeys }),
      ).toMatchObject({ ok: false, signature: 'invalid' });
    });

    it('invalidates the signature when the signed digest is swapped', async () => {
      const signed = signManifest(buildManifest('v1.4.0', provenance, files), 'release-2026', 'release-secret');
      const other = buildManifest('v1.4.1', provenance, files);
      const { present, read } = reader(files);
      const report = await verifyManifest({ ...other, signature: signed.signature }, present, read, { trustedKeys });
      expect(report).toMatchObject({ ok: false, signature: 'invalid', digestValid: true });
    });
  });
});
