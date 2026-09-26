import { Injectable, Logger } from '@nestjs/common';
import {
  MigrationDefinition,
  MigrationPhaseReport,
  MigrationRecord,
  MigrationRunReport,
} from './migration.interface';

/**
 * Migration safety framework (issue #263): dry-run preview, mandatory
 * post-checks, and a recorded rollback/forward-fix path.
 *
 * Execution order per migration:
 *
 *   1. dry-run  — always runs first, including before a real apply, so the
 *                 affected-record estimate is in the log even when someone
 *                 runs with `dryRun: false`.
 *   2. apply    — skipped entirely when `dryRun` is requested.
 *   3. post-checks — every check runs even if an earlier one failed, so one
 *                 broken check cannot hide a second inconsistency.
 *
 * A failed apply or a failed post-check marks the whole run `ok: false` and
 * records `rollbackNotes` from the definition, so the recovery path is
 * written down next to the failure rather than living in someone's head.
 */
@Injectable()
export class MigrationSafetyService {
  private readonly logger = new Logger(MigrationSafetyService.name);
  private readonly definitions = new Map<string, MigrationDefinition>();
  private readonly history: MigrationRecord[] = [];

  register(definition: MigrationDefinition): void {
    if (!definition?.id) {
      throw new Error('migration definition requires an id');
    }
    if (this.definitions.has(definition.id)) {
      throw new Error(`migration already registered: ${definition.id}`);
    }
    this.definitions.set(definition.id, definition);
    this.logger.log(`registered migration: ${definition.id}`);
  }

  /**
   * Run one migration. `dryRun: true` reports affected records and touches
   * nothing; `dryRun: false` runs the preview first, then applies, then runs
   * every post-check.
   */
  async run(migrationId: string, options: { dryRun?: boolean; context?: Record<string, any> } = {}): Promise<MigrationRunReport> {
    const definition = this.definitions.get(migrationId);
    if (!definition) {
      throw new Error(`unknown migration: ${migrationId}`);
    }

    const dryRunOnly = options.dryRun !== false; // default is dry-run: no writes unless asked for
    const context = options.context ?? {};
    const startedAt = new Date().toISOString();

    const report: MigrationRunReport = {
      migrationId,
      dryRunOnly,
      startedAt,
      ok: false,
      phases: [],
    };

    // ── 1. dry-run ──────────────────────────────────────────────────────────
    const dryRunPhase: MigrationPhaseReport = {
      phase: 'dry-run',
      startedAt: new Date().toISOString(),
      ok: false,
    };
    report.phases.push(dryRunPhase);
    try {
      dryRunPhase.affected = await definition.dryRun(context);
      dryRunPhase.ok = true;
      for (const affected of dryRunPhase.affected) {
        this.logger.log(
          `[${migrationId}] would affect ${affected.target}${affected.estimate !== undefined ? ` (~${affected.estimate} rows)` : ''}: ${affected.detail}`,
        );
      }
    } catch (error) {
      dryRunPhase.error = error instanceof Error ? error.message : String(error);
      this.finishReport(report, definition, dryRunOnly, dryRunPhase.error);
      return report;
    }

    if (dryRunOnly) {
      dryRunPhase.finishedAt = new Date().toISOString();
      this.finishReport(report, definition, dryRunOnly);
      return report;
    }

    // ── 2. apply ────────────────────────────────────────────────────────────
    const applyPhase: MigrationPhaseReport = {
      phase: 'apply',
      startedAt: new Date().toISOString(),
      ok: false,
    };
    report.phases.push(applyPhase);
    try {
      await definition.apply(context);
      applyPhase.ok = true;
    } catch (error) {
      applyPhase.error = error instanceof Error ? error.message : String(error);
      this.finishReport(report, definition, dryRunOnly, applyPhase.error);
      return report;
    }

    // ── 3. post-checks ──────────────────────────────────────────────────────
    const postCheckPhase: MigrationPhaseReport = {
      phase: 'post-check',
      startedAt: new Date().toISOString(),
      ok: true,
      postCheckResults: [],
    };
    report.phases.push(postCheckPhase);

    // Run every check even if one fails: an early failure must not mask a
    // second, independent inconsistency.
    for (const postCheck of definition.postChecks ?? []) {
      let failure: string | null = null;
      try {
        failure = await postCheck.check(context);
      } catch (error) {
        failure = `post-check threw: ${error instanceof Error ? error.message : String(error)}`;
      }
      postCheckPhase.postCheckResults.push({ name: postCheck.name, passed: failure === null, detail: failure ?? undefined });
      if (failure !== null) {
        postCheckPhase.ok = false;
        this.logger.error(`[${migrationId}] post-check failed: ${postCheck.name}: ${failure}`);
      }
    }
    postCheckPhase.finishedAt = new Date().toISOString();

    this.finishReport(report, definition, dryRunOnly, postCheckPhase.ok ? undefined : 'post-check failures');
    return report;
  }

  /** Every recorded run, newest first — the audit trail for migrations. */
  getHistory(): MigrationRecord[] {
    return [...this.history].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getRegisteredIds(): string[] {
    return [...this.definitions.keys()];
  }

  isRegistered(migrationId: string): boolean {
    return this.definitions.has(migrationId);
  }

  clear(): void {
    this.definitions.clear();
    this.history.length = 0;
  }

  private finishReport(
    report: MigrationRunReport,
    definition: MigrationDefinition,
    dryRunOnly: boolean,
    error?: string,
  ): void {
    report.finishedAt = new Date().toISOString();
    report.ok = error === undefined;
    report.error = error;
    report.rollbackNotes = definition.rollback;

    this.history.push({
      migrationId: report.migrationId,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      ok: report.ok,
      dryRunOnly: report.dryRunOnly,
      affected: report.phases.find((p) => p.phase === 'dry-run')?.affected ?? [],
      postCheckResults: report.phases.find((p) => p.phase === 'post-check')?.postCheckResults ?? [],
      rollbackNotes: definition.rollback,
      error,
    });
  }
}
