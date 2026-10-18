/**
 * Migration compatibility checks for the next storage schema version (#392).
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceUnavailableException } from '@nestjs/common';
import * as compat from './storage-schema-compat';
import {
  MigrationPlan,
  StorageCompatInputs,
  StorageFixture,
  checkStorageMigrationCompatibility,
  diffFixtures,
  findRepoRoot,
  loadStorageCompatInputs,
} from './storage-schema-compat';
import { MigrationSafetyController } from './migration-safety.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

const fx = (entries: Record<string, Record<string, string>>): StorageFixture =>
  Object.fromEntries(
    Object.entries(entries).map(([contract, keys]) => [
      contract,
      Object.fromEntries(Object.entries(keys).map(([k, hex]) => [k, { constructor: k, xdr_hex: hex }])),
    ]),
  );

const BASELINE = fx({
  'bond-issuer': { Admin: 'aa', 'HolderBalance(1, addr)': 'b1', BondCount: 'c1' },
  'coupon-engine': { Admin: 'aa', Precision: 'p1' },
});

const plan = (overrides: Partial<MigrationPlan> = {}): MigrationPlan => ({
  fromVersion: 1,
  toVersion: 2,
  status: 'ready',
  baseline: 'storage_keys.v1.json',
  rollback: 'Re-execute pinned v1 WASM via governance.',
  steps: [],
  ...overrides,
});

const holderRewrite = {
  contract: 'bond-issuer',
  key: 'HolderBalance(1, addr)',
  action: 'rewrite' as const,
  to: 'HolderBalanceV2(1, addr)',
  description: 'Move balances to the v2 key with checkpoint metadata.',
  idempotent: true,
  resumable: true,
  governanceGated: true,
  migrationWindow: true,
};

function inputs(overrides: Partial<StorageCompatInputs> = {}): StorageCompatInputs {
  return {
    baseline: BASELINE,
    baselineVersion: 1,
    candidate: BASELINE,
    candidateVersions: { 'bond-issuer': 1, 'coupon-engine': 1 },
    suiteVersion: 1,
    plan: plan({ status: 'draft' }),
    ...overrides,
  };
}

/** Candidate where HolderBalance moved to a new key (a breaking change). */
const MOVED = fx({
  'bond-issuer': { Admin: 'aa', 'HolderBalanceV2(1, addr)': 'b2', BondCount: 'c1' },
  'coupon-engine': { Admin: 'aa', Precision: 'p1' },
});
const bumped = { 'bond-issuer': 2, 'coupon-engine': 2 };

const codes = (r: ReturnType<typeof checkStorageMigrationCompatibility>) => r.violations.map((v) => v.code).sort();

describe('diffFixtures', () => {
  it('classifies added, removed and re-encoded keys', () => {
    const candidate = fx({
      'bond-issuer': { Admin: 'aa', 'HolderBalance(1, addr)': 'CHANGED', NewKey: 'n1' },
      'coupon-engine': { Admin: 'aa', Precision: 'p1' },
    });
    expect(diffFixtures(BASELINE, candidate)).toEqual([
      { contract: 'bond-issuer', key: 'BondCount', kind: 'removed' },
      { contract: 'bond-issuer', key: 'HolderBalance(1, addr)', kind: 'changed' },
      { contract: 'bond-issuer', key: 'NewKey', kind: 'added' },
    ]);
  });
});

describe('checkStorageMigrationCompatibility', () => {
  it('normal path: an identical layout is compatible with a draft plan', () => {
    const r = checkStorageMigrationCompatibility(inputs());
    expect(r).toMatchObject({ compatible: true, baselineVersion: 1, nextVersion: 2, violations: [] });
    expect(r.classification).toEqual({ 'bond-issuer': 'identical', 'coupon-engine': 'identical' });
  });

  it('normal path: additive keys keep the version and need no plan', () => {
    const candidate = fx({
      'bond-issuer': { Admin: 'aa', 'HolderBalance(1, addr)': 'b1', BondCount: 'c1', 'NewIndex(1)': 'n1' },
      'coupon-engine': { Admin: 'aa', Precision: 'p1' },
    });
    const r = checkStorageMigrationCompatibility(inputs({ candidate, plan: undefined }));
    expect(r.compatible).toBe(true);
    expect(r.classification['bond-issuer']).toBe('additive');
  });

  it('normal path: a breaking change with a bump and a complete ready plan is compatible', () => {
    const r = checkStorageMigrationCompatibility(
      inputs({ candidate: MOVED, candidateVersions: bumped, suiteVersion: 2, plan: plan({ steps: [holderRewrite] }) }),
    );
    expect(r.violations).toEqual([]);
    expect(r.compatible).toBe(true);
    expect(r.classification['bond-issuer']).toBe('breaking');
    // coupon-engine bumped with the suite but did not change: allowed, flagged.
    expect(r.warnings.map((w) => w.code)).toEqual(['VERSION_BUMP_WITHOUT_BREAKING_CHANGE']);
  });

  it('failure path: a breaking change without a version bump is rejected', () => {
    const r = checkStorageMigrationCompatibility(inputs({ candidate: MOVED, plan: plan({ steps: [holderRewrite] }) }));
    expect(codes(r)).toContain('BREAKING_CHANGE_WITHOUT_VERSION_BUMP');
  });

  it('failure path: a breaking change with no plan file is rejected', () => {
    const r = checkStorageMigrationCompatibility(
      inputs({ candidate: MOVED, candidateVersions: bumped, suiteVersion: 2, plan: undefined }),
    );
    expect(codes(r)).toEqual(['UNPLANNED_BREAKING_CHANGE']);
  });

  it('failure path: a plan that misses a removed key, or is still a draft, is rejected', () => {
    const r = checkStorageMigrationCompatibility(
      inputs({ candidate: MOVED, candidateVersions: bumped, suiteVersion: 2, plan: plan({ status: 'draft' }) }),
    );
    expect(codes(r)).toEqual(['PLAN_NOT_READY', 'UNPLANNED_BREAKING_CHANGE']);
    expect(r.violations.find((v) => v.code === 'UNPLANNED_BREAKING_CHANGE')!.key).toBe('HolderBalance(1, addr)');
  });

  it('failure path: version skips, regressions and suite drift are rejected', () => {
    expect(codes(checkStorageMigrationCompatibility(inputs({ candidateVersions: { 'bond-issuer': 3, 'coupon-engine': 1 } }))))
      .toEqual(['SUITE_VERSION_MISMATCH', 'VERSION_SKIP']);
    expect(codes(checkStorageMigrationCompatibility(inputs({ baselineVersion: 2, candidateVersions: { 'bond-issuer': 1, 'coupon-engine': 2 }, suiteVersion: 2, plan: undefined }))))
      .toEqual(['SUITE_VERSION_MISMATCH', 'VERSION_REGRESSION']);
    expect(codes(checkStorageMigrationCompatibility(inputs({ candidateVersions: { 'bond-issuer': 2, 'coupon-engine': 1 } }))))
      .toEqual(['SUITE_VERSION_MISMATCH']);
    expect(codes(checkStorageMigrationCompatibility(inputs({ candidateVersions: { 'bond-issuer': 1 } }))))
      .toEqual(['UNKNOWN_CONTRACT']);
  });

  it('failure path: malformed or mis-versioned plans are rejected', () => {
    expect(codes(checkStorageMigrationCompatibility(inputs({ plan: { toVersion: 'two' } })))).toEqual(['PLAN_INVALID']);
    expect(codes(checkStorageMigrationCompatibility(inputs({ plan: plan({ fromVersion: 1, toVersion: 3 }) })))).toEqual(['PLAN_VERSION_MISMATCH']);
  });

  it('in-flight investor state can never be retired', () => {
    const r = checkStorageMigrationCompatibility(
      inputs({
        candidate: MOVED,
        candidateVersions: bumped,
        suiteVersion: 2,
        plan: plan({ steps: [{ ...holderRewrite, action: 'retire', to: undefined }] }),
      }),
    );
    expect(codes(r)).toEqual(['IN_FLIGHT_STATE_RETIRED']);
  });

  it('in-flight state is rewritten only inside a migration window, to a real v2 key', () => {
    const r = checkStorageMigrationCompatibility(
      inputs({
        candidate: MOVED,
        candidateVersions: bumped,
        suiteVersion: 2,
        plan: plan({ steps: [{ ...holderRewrite, migrationWindow: false, to: 'Typo(1, addr)' }] }),
      }),
    );
    expect(codes(r)).toEqual(['MIGRATION_WINDOW_REQUIRED', 'REWRITE_TARGET_MISSING']);
  });

  it('a re-encoded key must be rewritten, not retired', () => {
    const candidate = fx({
      'bond-issuer': { Admin: 'aa', 'HolderBalance(1, addr)': 'b1', BondCount: 'NEW' },
      'coupon-engine': { Admin: 'aa', Precision: 'p1' },
    });
    const step = { ...holderRewrite, key: 'BondCount', action: 'retire' as const, to: undefined, resumable: false };
    const r = checkStorageMigrationCompatibility(
      inputs({ candidate, candidateVersions: bumped, suiteVersion: 2, plan: plan({ steps: [step] }) }),
    );
    expect(codes(r)).toEqual(['REWRITE_TARGET_MISSING']);
  });

  it('retry path: steps must be idempotent, and keyed families resumable', () => {
    const r = checkStorageMigrationCompatibility(
      inputs({
        candidate: MOVED,
        candidateVersions: bumped,
        suiteVersion: 2,
        plan: plan({ steps: [{ ...holderRewrite, idempotent: false, resumable: false }] }),
      }),
    );
    expect(codes(r)).toEqual(['NON_IDEMPOTENT_STEP', 'NON_RESUMABLE_STEP']);
  });

  it('authorization path: every step must run through the governance timelock', () => {
    const r = checkStorageMigrationCompatibility(
      inputs({
        candidate: MOVED,
        candidateVersions: bumped,
        suiteVersion: 2,
        plan: plan({ steps: [{ ...holderRewrite, governanceGated: false }] }),
      }),
    );
    expect(codes(r)).toEqual(['UNGATED_STEP']);
  });

  it('stale plan steps (keys that never existed) are rejected; no-op steps warn', () => {
    const r = checkStorageMigrationCompatibility(
      inputs({
        plan: plan({
          status: 'draft',
          steps: [
            { ...holderRewrite, key: 'Ghost(1)' },
            { ...holderRewrite, key: 'BondCount', action: 'retire', to: undefined },
          ],
        }),
      }),
    );
    expect(codes(r)).toEqual(['STALE_PLAN_STEP']);
    expect(r.warnings.map((w) => w.code)).toEqual(['PLANNED_STEP_WITHOUT_CHANGE']);
  });

  it('a breaking plan must document rollback', () => {
    const r = checkStorageMigrationCompatibility(
      inputs({ candidate: MOVED, candidateVersions: bumped, suiteVersion: 2, plan: plan({ steps: [holderRewrite], rollback: ' ' }) }),
    );
    expect(codes(r)).toEqual(['MISSING_ROLLBACK']);
  });

  it('is deterministic: re-running on the same inputs gives the same report', () => {
    const i = inputs({ candidate: MOVED, candidateVersions: bumped, suiteVersion: 2, plan: plan({ status: 'draft' }) });
    expect(checkStorageMigrationCompatibility(i)).toEqual(checkStorageMigrationCompatibility(i));
  });
});

describe('loadStorageCompatInputs (repository layout)', () => {
  let root: string;
  const write = (rel: string, content: string) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const fixture = JSON.stringify(BASELINE);
  const lib = (v: number) => `pub const SCHEMA_VERSION: u32 = ${v};\n`;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-compat-'));
    write('contracts/shared/src/lib.rs', 'pub const CURRENT_SCHEMA_VERSION: u32 = 1;\n');
    write('contracts/bond-issuer/src/lib.rs', lib(1));
    write('contracts/coupon-engine/src/lib.rs', lib(1));
    write('contracts/tests/fixtures/storage_keys.json', fixture);
    write('contracts/tests/fixtures/storage_keys.v1.json', fixture);
    write('contracts/tests/fixtures/schema_migrations/v2.json', JSON.stringify(plan({ status: 'draft' })));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads versions, baseline and the next plan', () => {
    const i = loadStorageCompatInputs(root);
    expect(i).toMatchObject({ baselineVersion: 1, suiteVersion: 1, candidateVersions: { 'bond-issuer': 1, 'coupon-engine': 1 } });
    expect(checkStorageMigrationCompatibility(i).compatible).toBe(true);
  });

  it('while a bump is in progress, the previous frozen fixture stays the baseline', () => {
    write('contracts/shared/src/lib.rs', 'pub const CURRENT_SCHEMA_VERSION: u32 = 2;\n');
    expect(loadStorageCompatInputs(root).baselineVersion).toBe(1);
    // Once v2 ships and is frozen, it becomes the baseline for v3.
    write('contracts/tests/fixtures/storage_keys.v2.json', fixture);
    const shipped = loadStorageCompatInputs(root);
    expect(shipped.baselineVersion).toBe(2);
    expect(shipped.plan).toBeUndefined();
  });

  it('fails loudly when no baseline exists', () => {
    fs.rmSync(path.join(root, 'contracts/tests/fixtures/storage_keys.v1.json'));
    expect(() => loadStorageCompatInputs(root)).toThrow(/no frozen baseline/);
  });
});

describe('repository gate (executable verification)', () => {
  it('the checked-in storage layout is compatible with the next schema version', () => {
    const report = checkStorageMigrationCompatibility(loadStorageCompatInputs(findRepoRoot()));
    expect(report.violations).toEqual([]);
    expect(report.compatible).toBe(true);
  });

  it('frozen baselines are immutable (pinned digest)', () => {
    // A baseline is the record of what is deployed. Editing it would hide a
    // breaking change from this gate, so it is pinned. Freeze a *new*
    // storage_keys.v<N>.json for a new version instead (see the doc).
    const FROZEN: Record<string, string> = {
      'storage_keys.v1.json': '02b7449dbb8fee4db86cecfb61144c43a0b0f1fed574918c9f7c7d85fb181e39',
    };
    const dir = path.join(findRepoRoot(), 'contracts', 'tests', 'fixtures');
    for (const [file, digest] of Object.entries(FROZEN)) {
      const actual = createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');
      expect({ file, digest: actual }).toEqual({ file, digest });
    }
  });

  it('the frozen v1 baseline covers every contract in the candidate fixture', () => {
    const i = loadStorageCompatInputs(findRepoRoot());
    expect(Object.keys(i.baseline).sort()).toEqual(Object.keys(i.candidate).sort());
    expect(Object.keys(i.candidateVersions).sort()).toEqual(Object.keys(i.candidate).sort());
  });
});

describe('GET /api/v1/migrations/storage-schema/compatibility', () => {
  it('is admin-only (JwtAuthGuard + AdminGuard at class level)', () => {
    const guards = Reflect.getMetadata('__guards__', MigrationSafetyController);
    expect(guards).toEqual([JwtAuthGuard, AdminGuard]);
  });

  it('returns the report for the repository', async () => {
    const controller = new MigrationSafetyController({} as any);
    await expect(controller.storageSchemaCompatibility()).resolves.toMatchObject({ compatible: true, nextVersion: 2 });
  });

  it('fails closed with 503 when inputs cannot be read', async () => {
    jest.spyOn(compat, 'loadStorageCompatInputs').mockImplementation(() => {
      throw new Error('baseline missing');
    });
    const controller = new MigrationSafetyController({} as any);
    await expect(controller.storageSchemaCompatibility()).rejects.toBeInstanceOf(ServiceUnavailableException);
    jest.restoreAllMocks();
  });
});
