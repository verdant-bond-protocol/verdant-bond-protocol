import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

/**
 * Migration compatibility checks for the next storage schema version (#392).
 *
 * The storage fixture (`contracts/tests/fixtures/storage_keys.json`, #159)
 * already catches *any* DataKey drift, and the release gate (#473) checks the
 * deployed version. Neither says whether a change is safe to ship as the next
 * schema version. This check compares the candidate fixture against the
 * frozen baseline of the current version (`storage_keys.v<N>.json`) and the
 * written migration plan (`schema_migrations/v<N+1>.json`), and enforces
 * docs/upgrade-migrations.md mechanically:
 *
 *   - additive changes (new keys) keep the version and need no plan;
 *   - a breaking change (a key removed, or its XDR encoding changed) must bump
 *     that contract's SCHEMA_VERSION by exactly one, together with the suite's
 *     CURRENT_SCHEMA_VERSION, and be covered by a ready plan step;
 *   - plan steps must be idempotent (a migration can be retried after partial
 *     failure), resumable over keyed families, governance-gated, and run in a
 *     migration window when they touch in-flight investor state, which can
 *     never be retired.
 *
 * Pure: `checkStorageMigrationCompatibility` takes parsed inputs, so every
 * rule is unit-testable; `loadStorageCompatInputs` reads the repo files.
 * See docs/storage-schema-migration-checks.md.
 */

export type StorageFixture = Record<string, Record<string, { constructor: string; xdr_hex: string }>>;

export const MigrationStepSchema = z.object({
  contract: z.string().min(1),
  /** Baseline fixture key, e.g. `HolderBalance(1, addr)`. */
  key: z.string().min(1),
  action: z.enum(['rewrite', 'retire']),
  /** For `rewrite`: the candidate fixture key the data moves to. */
  to: z.string().min(1).optional(),
  description: z.string().min(1),
  idempotent: z.boolean(),
  /** Processes keyed entries in batches with a persisted cursor. */
  resumable: z.boolean().optional(),
  governanceGated: z.boolean(),
  migrationWindow: z.boolean().optional(),
});

export const MigrationPlanSchema = z.object({
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
  status: z.enum(['draft', 'ready']),
  baseline: z.string().min(1),
  description: z.string().optional(),
  rollback: z.string(),
  steps: z.array(MigrationStepSchema),
});

export type MigrationStep = z.infer<typeof MigrationStepSchema>;
export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

/**
 * DataKey families holding in-flight investor or protocol state (balances,
 * escrow, unclaimed coupons, open orders, reports and proposals). They may be
 * rewritten only inside a migration window and never retired.
 */
export const IN_FLIGHT_STATE_KEYS: Readonly<Record<string, readonly string[]>> = {
  'bond-issuer': ['BondConfig', 'BondState', 'HolderBalance', 'RedemptionPool'],
  'coupon-engine': [
    'EscrowedCredits',
    'EscrowedCreditsByType',
    'PeriodHolder',
    'PeriodInfo',
    'TrueUpAdjustment',
    'UndistributedTotal',
  ],
  'credit-retirement': ['HolderRetirements', 'RetiredCredits', 'RetiredPerBond', 'Retirement'],
  'dex-router': ['Balance', 'BondEscrow', 'BondOrders', 'Order', 'SellerOrders'],
  governance: ['Proposal', 'Vote'],
  'oracle-consumer': ['Challenge', 'Report', 'ReportVerifiers', 'VerificationCount'],
  'project-registry': ['Project', 'ProjectDocuments'],
};

export type ChangeKind = 'added' | 'removed' | 'changed';
export type Classification = 'identical' | 'additive' | 'breaking';

export interface KeyChange {
  contract: string;
  key: string;
  kind: ChangeKind;
}

export type ViolationCode =
  | 'PLAN_INVALID'
  | 'PLAN_VERSION_MISMATCH'
  | 'PLAN_NOT_READY'
  | 'MISSING_ROLLBACK'
  | 'BREAKING_CHANGE_WITHOUT_VERSION_BUMP'
  | 'VERSION_SKIP'
  | 'VERSION_REGRESSION'
  | 'SUITE_VERSION_MISMATCH'
  | 'UNPLANNED_BREAKING_CHANGE'
  | 'STALE_PLAN_STEP'
  | 'REWRITE_TARGET_MISSING'
  | 'IN_FLIGHT_STATE_RETIRED'
  | 'MIGRATION_WINDOW_REQUIRED'
  | 'NON_IDEMPOTENT_STEP'
  | 'NON_RESUMABLE_STEP'
  | 'UNGATED_STEP'
  | 'UNKNOWN_CONTRACT';

export interface Finding {
  code: ViolationCode | 'VERSION_BUMP_WITHOUT_BREAKING_CHANGE' | 'PLANNED_STEP_WITHOUT_CHANGE';
  message: string;
  contract?: string;
  key?: string;
}

export interface StorageCompatInputs {
  baseline: StorageFixture;
  baselineVersion: number;
  candidate: StorageFixture;
  /** SCHEMA_VERSION per contract as currently written in the Rust sources. */
  candidateVersions: Record<string, number>;
  /** `CURRENT_SCHEMA_VERSION` in contracts/shared. */
  suiteVersion: number;
  /** Raw plan JSON for baselineVersion + 1, or undefined when none exists. */
  plan?: unknown;
}

export interface StorageCompatReport {
  compatible: boolean;
  baselineVersion: number;
  nextVersion: number;
  classification: Record<string, Classification>;
  changes: KeyChange[];
  violations: Finding[];
  warnings: Finding[];
}

const family = (key: string) => key.split('(')[0];
const isKeyed = (key: string) => key.includes('(');
const isInFlight = (contract: string, key: string) =>
  (IN_FLIGHT_STATE_KEYS[contract] ?? []).includes(family(key));

export function diffFixtures(baseline: StorageFixture, candidate: StorageFixture): KeyChange[] {
  const changes: KeyChange[] = [];
  const contracts = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  for (const contract of contracts) {
    const before = baseline[contract] ?? {};
    const after = candidate[contract] ?? {};
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (!(key in after)) changes.push({ contract, key, kind: 'removed' });
      else if (!(key in before)) changes.push({ contract, key, kind: 'added' });
      else if (before[key].xdr_hex !== after[key].xdr_hex) changes.push({ contract, key, kind: 'changed' });
    }
  }
  return changes;
}

export function checkStorageMigrationCompatibility(input: StorageCompatInputs): StorageCompatReport {
  const nextVersion = input.baselineVersion + 1;
  const violations: Finding[] = [];
  const warnings: Finding[] = [];
  const changes = diffFixtures(input.baseline, input.candidate);
  const breaking = changes.filter((c) => c.kind !== 'added');

  const classification: Record<string, Classification> = {};
  for (const contract of [...new Set([...Object.keys(input.baseline), ...Object.keys(input.candidate)])].sort()) {
    const mine = changes.filter((c) => c.contract === contract);
    classification[contract] = mine.length === 0
      ? 'identical'
      : mine.some((c) => c.kind !== 'added') ? 'breaking' : 'additive';
  }

  // ── Versions ────────────────────────────────────────────────────────────
  for (const [contract, cls] of Object.entries(classification)) {
    const version = input.candidateVersions[contract];
    if (version === undefined) {
      violations.push({ code: 'UNKNOWN_CONTRACT', contract, message: `no SCHEMA_VERSION found for ${contract}` });
      continue;
    }
    if (version < input.baselineVersion) {
      violations.push({ code: 'VERSION_REGRESSION', contract, message: `${contract} SCHEMA_VERSION ${version} is below baseline ${input.baselineVersion}` });
    } else if (version > nextVersion) {
      violations.push({ code: 'VERSION_SKIP', contract, message: `${contract} SCHEMA_VERSION ${version} skips past ${nextVersion}` });
    } else if (cls === 'breaking' && version === input.baselineVersion) {
      violations.push({
        code: 'BREAKING_CHANGE_WITHOUT_VERSION_BUMP',
        contract,
        message: `${contract} has breaking storage changes but SCHEMA_VERSION is still ${version}; bump to ${nextVersion}`,
      });
    } else if (cls !== 'breaking' && version === nextVersion) {
      warnings.push({
        code: 'VERSION_BUMP_WITHOUT_BREAKING_CHANGE',
        contract,
        message: `${contract} bumped to ${nextVersion} without a breaking storage change (allowed for interface changes)`,
      });
    }
    if (version !== input.suiteVersion) {
      violations.push({
        code: 'SUITE_VERSION_MISMATCH',
        contract,
        message: `${contract} SCHEMA_VERSION ${version} != CURRENT_SCHEMA_VERSION ${input.suiteVersion}; versions move suite-wide`,
      });
    }
  }

  // ── Plan ────────────────────────────────────────────────────────────────
  let plan: MigrationPlan | undefined;
  if (input.plan !== undefined) {
    const parsed = MigrationPlanSchema.safeParse(input.plan);
    if (!parsed.success) {
      violations.push({ code: 'PLAN_INVALID', message: `migration plan is invalid: ${parsed.error.message}` });
    } else {
      plan = parsed.data;
      if (plan.fromVersion !== input.baselineVersion || plan.toVersion !== nextVersion) {
        violations.push({
          code: 'PLAN_VERSION_MISMATCH',
          message: `plan migrates ${plan.fromVersion}->${plan.toVersion}, expected ${input.baselineVersion}->${nextVersion}`,
        });
      }
    }
  }

  if (breaking.length > 0) {
    if (!plan) {
      if (input.plan === undefined) {
        violations.push({ code: 'UNPLANNED_BREAKING_CHANGE', message: `breaking storage changes need schema_migrations/v${nextVersion}.json` });
      }
    } else {
      if (plan.status !== 'ready') {
        violations.push({ code: 'PLAN_NOT_READY', message: `plan v${nextVersion} is "${plan.status}"; mark it "ready" once reviewed` });
      }
      if (plan.rollback.trim().length === 0) {
        violations.push({ code: 'MISSING_ROLLBACK', message: 'a plan with breaking changes must document its rollback path' });
      }
    }
  }

  const steps = plan?.steps ?? [];
  for (const change of breaking) {
    const step = steps.find((s) => s.contract === change.contract && s.key === change.key);
    if (!step) {
      if (plan) {
        violations.push({
          code: 'UNPLANNED_BREAKING_CHANGE',
          contract: change.contract,
          key: change.key,
          message: `${change.contract}::${change.key} was ${change.kind} but no plan step migrates or retires it`,
        });
      }
      continue;
    }
    if (change.kind === 'changed' && step.action === 'retire') {
      // A changed encoding at the same constructor means live data under the
      // old encoding still exists; it has to be rewritten, not dropped.
      violations.push({
        code: 'REWRITE_TARGET_MISSING',
        contract: change.contract,
        key: change.key,
        message: `${change.contract}::${change.key} changed encoding; it must be rewritten, not retired`,
      });
    }
  }

  for (const step of steps) {
    const where = { contract: step.contract, key: step.key };
    const label = `${step.contract}::${step.key}`;
    if (!(step.contract in input.baseline) || !(step.key in input.baseline[step.contract])) {
      violations.push({ code: 'STALE_PLAN_STEP', ...where, message: `${label} is not a v${input.baselineVersion} key` });
      continue;
    }
    if (!breaking.some((c) => c.contract === step.contract && c.key === step.key)) {
      warnings.push({ code: 'PLANNED_STEP_WITHOUT_CHANGE', ...where, message: `${label} has a plan step but did not change` });
    }
    if (step.action === 'rewrite') {
      if (!step.to || !(step.to in (input.candidate[step.contract] ?? {}))) {
        violations.push({ code: 'REWRITE_TARGET_MISSING', ...where, message: `${label} rewrites to ${step.to ?? '<none>'}, which is not a v${nextVersion} key` });
      }
      if (isInFlight(step.contract, step.key) && !step.migrationWindow) {
        violations.push({ code: 'MIGRATION_WINDOW_REQUIRED', ...where, message: `${label} holds in-flight state; rewrite it inside begin_migration/finalize_migration` });
      }
    }
    if (step.action === 'retire' && isInFlight(step.contract, step.key)) {
      violations.push({ code: 'IN_FLIGHT_STATE_RETIRED', ...where, message: `${label} holds in-flight state and cannot be retired` });
    }
    if (!step.idempotent) {
      violations.push({ code: 'NON_IDEMPOTENT_STEP', ...where, message: `${label} must be idempotent so a partially applied migration can be retried` });
    }
    if (step.action === 'rewrite' && isKeyed(step.key) && !step.resumable) {
      violations.push({ code: 'NON_RESUMABLE_STEP', ...where, message: `${label} is a keyed family; migrate in cursor batches (resumable: true)` });
    }
    if (!step.governanceGated) {
      violations.push({ code: 'UNGATED_STEP', ...where, message: `${label} must execute through the governance timelock` });
    }
  }

  return {
    compatible: violations.length === 0,
    baselineVersion: input.baselineVersion,
    nextVersion,
    classification,
    changes,
    violations,
    warnings,
  };
}

// ── Repository loader ─────────────────────────────────────────────────────

const SCHEMA_VERSION_RE = /pub const SCHEMA_VERSION: u32 = (\d+);/;
const SUITE_VERSION_RE = /pub const CURRENT_SCHEMA_VERSION: u32 = (\d+);/;

/** Locate the repository root from the API source, dist or CWD. */
export function findRepoRoot(start: string[] = [__dirname, process.cwd()]): string {
  for (const dir of start) {
    let current = path.resolve(dir);
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(current, 'contracts', 'tests', 'fixtures', 'storage_keys.json'))) return current;
      current = path.dirname(current);
    }
  }
  throw new Error('repository root with contracts/tests/fixtures/storage_keys.json not found');
}

/** Read the baseline, candidate, plan and versions from the repository. */
export function loadStorageCompatInputs(repoRoot = findRepoRoot()): StorageCompatInputs {
  const contractsDir = path.join(repoRoot, 'contracts');
  const fixturesDir = path.join(contractsDir, 'tests', 'fixtures');
  const read = (p: string) => fs.readFileSync(p, 'utf8');

  const suiteMatch = SUITE_VERSION_RE.exec(read(path.join(contractsDir, 'shared', 'src', 'lib.rs')));
  if (!suiteMatch) throw new Error('CURRENT_SCHEMA_VERSION not found in contracts/shared/src/lib.rs');
  const suiteVersion = Number(suiteMatch[1]);

  const candidate = JSON.parse(read(path.join(fixturesDir, 'storage_keys.json'))) as StorageFixture;
  const candidateVersions: Record<string, number> = {};
  for (const contract of Object.keys(candidate)) {
    const libPath = path.join(contractsDir, contract, 'src', 'lib.rs');
    const match = fs.existsSync(libPath) ? SCHEMA_VERSION_RE.exec(read(libPath)) : null;
    if (match) candidateVersions[contract] = Number(match[1]);
  }

  // The baseline is the newest frozen fixture not ahead of the suite: while a
  // bump to N+1 is in progress only v<N> is frozen; once N+1 ships, its
  // fixture is frozen and becomes the baseline for N+2.
  let baselineVersion = suiteVersion;
  while (baselineVersion > 0 && !fs.existsSync(path.join(fixturesDir, `storage_keys.v${baselineVersion}.json`))) {
    baselineVersion--;
  }
  if (baselineVersion === 0) {
    throw new Error(`no frozen baseline fixture storage_keys.v<N>.json (N <= ${suiteVersion}) found`);
  }
  const baselinePath = path.join(fixturesDir, `storage_keys.v${baselineVersion}.json`);

  const planPath = path.join(fixturesDir, 'schema_migrations', `v${baselineVersion + 1}.json`);
  return {
    baseline: JSON.parse(read(baselinePath)) as StorageFixture,
    baselineVersion,
    candidate,
    candidateVersions,
    suiteVersion,
    plan: fs.existsSync(planPath) ? JSON.parse(read(planPath)) : undefined,
  };
}
