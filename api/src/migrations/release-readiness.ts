import { MigrationDefinition, MigrationRecord } from './migration.interface';

/**
 * Release readiness checks for migrations and rollback (#514).
 *
 * The migration safety framework (#263) records what each run did; nothing
 * yet answers "can we ship a release containing these migrations, and can we
 * get back out if it goes wrong?". This module turns the registered
 * definitions plus the run history into a go/no-go report:
 *
 *   - every migration in the release is registered,
 *   - each has a real rollback / forward-fix note (not "TODO"),
 *   - each has at least one post-check, so a bad apply is detected,
 *   - each has a passing dry-run that is recent enough to trust, and
 *   - no migration's most recent apply failed without a later successful
 *     retry.
 *
 * It also emits the rollback plan — rollback notes in reverse release order —
 * so the recovery path ships with the release decision.
 *
 * Pure: no clock, logger, or I/O. `now` is injected.
 */

export type ReadinessCheckName =
  | 'registered'
  | 'rollback-documented'
  | 'post-checks-defined'
  | 'dry-run-passed'
  | 'dry-run-fresh'
  | 'no-unresolved-failure';

export interface ReadinessCheckResult {
  name: ReadinessCheckName;
  passed: boolean;
  detail?: string;
}

export interface MigrationReadiness {
  migrationId: string;
  ready: boolean;
  checks: ReadinessCheckResult[];
  /** Failed applies that a later successful apply recovered from. */
  recoveredFailures: number;
}

export interface RollbackStep {
  order: number;
  migrationId: string;
  rollback: string;
}

export interface ReleaseReadinessReport {
  status: 'READY' | 'BLOCKED';
  evaluatedAt: string;
  migrations: MigrationReadiness[];
  /** Ids of migrations that block the release. */
  blockers: string[];
  /** Execute top to bottom to unwind the release. */
  rollbackPlan: RollbackStep[];
}

export interface ReleaseReadinessInput {
  /** Migrations included in the release, in apply order. */
  releaseMigrationIds: string[];
  definitions: Pick<MigrationDefinition, 'id' | 'rollback' | 'postChecks'>[];
  history: MigrationRecord[];
  now: Date;
  /** A dry-run older than this no longer reflects production. Default 24h. */
  maxDryRunAgeMs?: number;
}

export const DEFAULT_MAX_DRY_RUN_AGE_MS = 24 * 60 * 60 * 1000;
const MIN_ROLLBACK_NOTE_LENGTH = 10;
const PLACEHOLDER_ROLLBACK = /^(todo|tbd|n\/?a|none|-|\.+|fixme|later)$/i;

export function isRollbackDocumented(rollback: string | undefined): boolean {
  const note = (rollback ?? '').trim();
  return note.length >= MIN_ROLLBACK_NOTE_LENGTH && !PLACEHOLDER_ROLLBACK.test(note) && !/^(todo|tbd|fixme)\b/i.test(note);
}

function byStartedAtAsc(a: MigrationRecord, b: MigrationRecord): number {
  return a.startedAt.localeCompare(b.startedAt);
}

function evaluateOne(
  migrationId: string,
  definition: ReleaseReadinessInput['definitions'][number] | undefined,
  history: MigrationRecord[],
  now: Date,
  maxDryRunAgeMs: number,
): MigrationReadiness {
  if (!definition) {
    return {
      migrationId,
      ready: false,
      recoveredFailures: 0,
      checks: [{ name: 'registered', passed: false, detail: 'migration is in the release but not registered' }],
    };
  }

  const runs = history.filter((record) => record.migrationId === migrationId).sort(byStartedAtAsc);
  const dryRuns = runs.filter((record) => record.dryRunOnly);
  const applies = runs.filter((record) => !record.dryRunOnly);
  const checks: ReadinessCheckResult[] = [{ name: 'registered', passed: true }];

  checks.push(
    isRollbackDocumented(definition.rollback)
      ? { name: 'rollback-documented', passed: true }
      : {
          name: 'rollback-documented',
          passed: false,
          detail: 'rollback note is missing or a placeholder; write the undo or forward-fix steps',
        },
  );

  const postCheckCount = definition.postChecks?.length ?? 0;
  checks.push(
    postCheckCount > 0
      ? { name: 'post-checks-defined', passed: true }
      : { name: 'post-checks-defined', passed: false, detail: 'no post-checks: a broken apply would go unnoticed' },
  );

  // Only the latest dry-run counts: a later failing preview supersedes an
  // earlier passing one.
  const latestDryRun = dryRuns[dryRuns.length - 1];
  if (!latestDryRun) {
    checks.push({ name: 'dry-run-passed', passed: false, detail: 'no dry-run recorded' });
  } else if (!latestDryRun.ok) {
    checks.push({
      name: 'dry-run-passed',
      passed: false,
      detail: `latest dry-run failed: ${latestDryRun.error ?? 'unknown error'}`,
    });
  } else {
    checks.push({ name: 'dry-run-passed', passed: true });
  }

  if (latestDryRun?.ok) {
    const ageMs = now.getTime() - Date.parse(latestDryRun.startedAt);
    checks.push(
      Number.isFinite(ageMs) && ageMs <= maxDryRunAgeMs
        ? { name: 'dry-run-fresh', passed: true }
        : {
            name: 'dry-run-fresh',
            passed: false,
            detail: `latest passing dry-run is older than ${Math.round(maxDryRunAgeMs / 60000)} minutes; re-run it`,
          },
    );
  }

  // Retry path: a failed apply is resolved by any later successful apply.
  const latestApply = applies[applies.length - 1];
  const recoveredFailures = latestApply?.ok ? applies.filter((record) => !record.ok).length : 0;
  if (latestApply && !latestApply.ok) {
    checks.push({
      name: 'no-unresolved-failure',
      passed: false,
      detail: `last apply at ${latestApply.startedAt} failed (${latestApply.error ?? 'unknown error'}); recover via: ${latestApply.rollbackNotes || definition.rollback}`,
    });
  } else {
    checks.push({ name: 'no-unresolved-failure', passed: true });
  }

  return { migrationId, ready: checks.every((check) => check.passed), checks, recoveredFailures };
}

export function evaluateMigrationReleaseReadiness(input: ReleaseReadinessInput): ReleaseReadinessReport {
  const maxDryRunAgeMs = input.maxDryRunAgeMs ?? DEFAULT_MAX_DRY_RUN_AGE_MS;
  const definitions = new Map(input.definitions.map((definition) => [definition.id, definition]));
  // A duplicated id would be applied (and rolled back) twice; evaluate once.
  const releaseIds = [...new Set(input.releaseMigrationIds)];

  const migrations = releaseIds.map((id) =>
    evaluateOne(id, definitions.get(id), input.history, input.now, maxDryRunAgeMs),
  );
  const blockers = migrations.filter((migration) => !migration.ready).map((migration) => migration.migrationId);

  const rollbackPlan = [...releaseIds]
    .reverse()
    .filter((id) => definitions.has(id))
    .map((id, index) => ({ order: index + 1, migrationId: id, rollback: definitions.get(id)!.rollback }));

  return {
    // An empty release is trivially shippable but almost always a mistake in
    // the caller; it is reported READY with no rows so the UI can flag it.
    status: blockers.length === 0 ? 'READY' : 'BLOCKED',
    evaluatedAt: input.now.toISOString(),
    migrations,
    blockers,
    rollbackPlan,
  };
}
