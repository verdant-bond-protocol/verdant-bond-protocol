#!/usr/bin/env node
/**
 * Release artifact manifest generator / verifier (#538).
 *
 *   ts-node --transpile-only scripts/release-artifacts.ts generate \
 *     --release v1.4.0 --root <artifact dir> --commit <sha> [--out release-manifest.json]
 *
 *   ts-node --transpile-only scripts/release-artifacts.ts verify \
 *     --manifest release-manifest.json --root <rebuilt artifact dir> [--expect-commit <sha>] [--json]
 *
 * Signing:   RELEASE_MANIFEST_KEY_ID + RELEASE_MANIFEST_KEY sign on generate.
 * Verifying: RELEASE_MANIFEST_TRUSTED_KEYS="keyId=secret[,keyId=secret]" makes a
 *            valid signature mandatory.
 *
 * Exit codes: 0 verified/written, 1 verification failed, 2 usage error,
 *             3 retryable (artifacts could not be read; run again).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ReleaseProvenance,
  buildManifest,
  serialiseManifest,
  sha256Hex,
  signManifest,
  verifyManifest,
  ReleaseManifest,
} from '../src/release/release-artifact-manifest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOCKFILES = ['api/package-lock.json', 'frontend/package-lock.json', 'oracle/package-lock.json', 'contracts/Cargo.lock'];

function arg(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(message: string): never {
  console.error(`[usage] ${message}`);
  process.exit(2);
}

function listFiles(root: string, dir = root): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) return []; // never follow links out of the release root
      if (entry.isDirectory()) return listFiles(root, full);
      return entry.isFile() ? [path.relative(root, full).split(path.sep).join('/')] : [];
    })
    .sort();
}

function currentProvenance(commit: string): ReleaseProvenance {
  const toolchain: Record<string, string> = { node: process.version };
  const rustToolchain = path.join(REPO_ROOT, 'contracts', 'rust-toolchain.toml');
  if (fs.existsSync(rustToolchain)) {
    const channel = /channel\s*=\s*"([^"]+)"/.exec(fs.readFileSync(rustToolchain, 'utf8'));
    if (channel) toolchain.rust = channel[1];
  }
  const lockfiles: Record<string, string> = {};
  for (const lockfile of LOCKFILES) {
    const full = path.join(REPO_ROOT, lockfile);
    if (fs.existsSync(full)) lockfiles[lockfile] = sha256Hex(fs.readFileSync(full));
  }
  return { commit, toolchain, lockfiles };
}

function trustedKeys(): Record<string, string> | undefined {
  const raw = process.env.RELEASE_MANIFEST_TRUSTED_KEYS;
  if (!raw) return undefined;
  return Object.fromEntries(
    raw
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const separator = pair.indexOf('=');
        if (separator <= 0) usage('RELEASE_MANIFEST_TRUSTED_KEYS entries must be keyId=secret');
        return [pair.slice(0, separator), pair.slice(separator + 1)];
      }),
  );
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const root = arg(args, 'root');
  if (!root || !fs.existsSync(root)) usage('--root <existing artifact directory> is required');

  if (command === 'generate') {
    const release = arg(args, 'release') ?? usage('--release is required');
    const commit = arg(args, 'commit') ?? process.env.GITHUB_SHA ?? usage('--commit (or GITHUB_SHA) is required');
    const inputs = listFiles(root).map((file) => ({ path: file, content: fs.readFileSync(path.join(root, file)) }));
    let manifest = buildManifest(release, currentProvenance(commit), inputs);
    const keyId = process.env.RELEASE_MANIFEST_KEY_ID;
    const key = process.env.RELEASE_MANIFEST_KEY;
    if (keyId && key) manifest = signManifest(manifest, keyId, key);
    const out = arg(args, 'out') ?? 'release-manifest.json';
    fs.writeFileSync(out, serialiseManifest(manifest));
    console.log(`Wrote ${out}: ${manifest.artifacts.length} artifact(s), digest ${manifest.digest}${manifest.signature ? `, signed by ${manifest.signature.keyId}` : ', unsigned'}`);
    return;
  }

  if (command === 'verify') {
    const manifestPath = arg(args, 'manifest') ?? usage('--manifest is required');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ReleaseManifest;
    const expectCommit = arg(args, 'expect-commit');
    const report = await verifyManifest(
      manifest,
      listFiles(root),
      async (file) => fs.promises.readFile(path.join(root, file)),
      {
        trustedKeys: trustedKeys(),
        expectedProvenance: expectCommit ? { commit: expectCommit } : undefined,
      },
    );
    if (args.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Release ${manifest.release}: ${report.ok ? 'VERIFIED' : report.retryable ? 'RETRY' : 'FAILED'}`);
      console.log(`  digest: ${report.digestValid ? 'ok' : 'INVALID'}  signature: ${report.signature}`);
      report.missing.forEach((p) => console.log(`  missing:    ${p}`));
      report.unexpected.forEach((p) => console.log(`  unexpected: ${p}`));
      report.mismatched.forEach((m) => console.log(`  mismatch:   ${m.path} expected ${m.expectedSha256} got ${m.actualSha256}`));
      report.unreadable.forEach((u) => console.log(`  unreadable: ${u.path} (${u.error})`));
      report.provenanceDrift.forEach((d) => console.log(`  drift:      ${d.field} expected ${d.expected} got ${d.actual}`));
    }
    process.exit(report.ok ? 0 : report.retryable ? 3 : 1);
  }

  usage('command must be "generate" or "verify"');
}

main().catch((err) => {
  console.error(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
