import { Injectable, Logger } from '@nestjs/common';
import { MigrationSafetyService } from '../../migrations/migration-safety.service';
import { ReleaseGateService } from './release-gate.service';
import {
  RollbackVerificationService,
  RollbackVerificationReport,
  RollbackVerificationInput,
} from '../../recovery/rollback-verification.service';
import { ReleaseGateStatus } from './release-gate.interface';

export type ReadinessStatus = 'READY' | 'BLOCKED' | 'WARNING';

export interface SmokeTestResult {
  passed: boolean;
  detail?: string;
}

export interface SmokeTestProbe {
  name: string;
  scope?: string;
  timeoutMs: number;
  run: () => Promise<SmokeTestResult>;
}

export interface SmokeTestReport {
  name: string;
  passed: boolean;
  durationMs: number;
  detail?: string;
  timedOut?: boolean;
}

export interface MigrationReadinessReport {
  registeredCount: number;
  dryRunResults: Array<{ migrationId: string; ok: boolean; error?: string; rollbackNotes?: string }>;
  allPassed: boolean;
}

export interface RollbackReadinessReport {
  status: RollbackVerificationReport['overallStatus'];
  isClean: boolean;
  repairCount: number;
  summaryText: string;
}

export interface ReadinessCheckResult {
  category: 'migration' | 'smoke-test' | 'rollback' | 'release-gate';
  passed: boolean;
  detail: string;
  rollbackSteps?: string;
}

export interface ReleaseReadinessReport {
  status: ReadinessStatus;
  evaluatedAt: string;
  dryRun: boolean;
  checks: ReadinessCheckResult[];
  migration: MigrationReadinessReport;
  smokeTests: SmokeTestReport[];
  rollback: RollbackReadinessReport;
  releaseGateCompatible: boolean;
  rollbackSteps: string[];
}

export interface ReleaseReadinessOptions {
  dryRun?: boolean;
  scope?: string;
  rollbackInput?: RollbackVerificationInput;
}

@Injectable()
export class ReleaseReadinessService {
  private readonly logger = new Logger(ReleaseReadinessService.name);
  private readonly smokeTests: SmokeTestProbe[] = [];

  constructor(
    private readonly migrations: MigrationSafetyService,
    private readonly releaseGate: ReleaseGateService,
    private readonly rollbackVerifier: RollbackVerificationService,
  ) {}

  registerSmokeTest(probe: SmokeTestProbe): void {
    if (this.smokeTests.some((p) => p.name === probe.name)) {
      throw new Error(`smoke test already registered: ${probe.name}`);
    }
    this.smokeTests.push(probe);
    this.logger.log(`registered smoke test: ${probe.name}`);
  }

  getRegisteredSmokeTests(): string[] {
    return this.smokeTests.map((p) => p.name);
  }

  async evaluate(options: ReleaseReadinessOptions = {}): Promise<ReleaseReadinessReport> {
    const isDryRun = options.dryRun !== false;
    const checks: ReadinessCheckResult[] = [];
    const rollbackSteps: string[] = [];

    // ── 1. Migration readiness ─────────────────────────────────────────────
    const migrationReport = await this.evaluateMigrations(isDryRun);
    if (!migrationReport.allPassed) {
      for (const result of migrationReport.dryRunResults) {
        if (!result.ok) {
          checks.push({
            category: 'migration',
            passed: false,
            detail: `Migration ${result.migrationId} failed: ${result.error}`,
            rollbackSteps: result.rollbackNotes,
          });
          if (result.rollbackNotes) {
            rollbackSteps.push(`[migration:${result.migrationId}] ${result.rollbackNotes}`);
          }
        }
      }
    } else {
      checks.push({
        category: 'migration',
        passed: true,
        detail: `All ${migrationReport.registeredCount} registered migration(s) passed dry-run`,
      });
    }

    // ── 2. Smoke tests ─────────────────────────────────────────────────────
    const applicableProbes = options.scope
      ? this.smokeTests.filter((p) => p.scope === options.scope || p.scope === undefined)
      : this.smokeTests;

    const smokeTestReports = await this.runSmokeTests(applicableProbes);
    for (const report of smokeTestReports) {
      if (!report.passed) {
        const reason = report.timedOut
          ? `Smoke test ${report.name} timed out after ${report.durationMs}ms`
          : `Smoke test ${report.name} failed: ${report.detail}`;
        checks.push({
          category: 'smoke-test',
          passed: false,
          detail: reason,
          rollbackSteps: `Investigate failing probe "${report.name}" before proceeding with release`,
        });
        rollbackSteps.push(`[smoke-test:${report.name}] Fix or disable probe before release`);
      } else {
        checks.push({
          category: 'smoke-test',
          passed: true,
          detail: `Smoke test ${report.name} passed in ${report.durationMs}ms`,
        });
      }
    }

    // ── 3. Rollback verification ───────────────────────────────────────────
    const rollbackInput = options.rollbackInput ?? {
      targetVersion: 'previous',
      bondRecords: [],
      jobRecords: [],
      externalRefRecords: [],
    };
    const rollbackReport = this.evaluateRollback(rollbackInput);
    if (!rollbackReport.isClean) {
      checks.push({
        category: 'rollback',
        passed: rollbackReport.status !== 'CRITICAL_MISMATCH',
        detail: rollbackReport.summaryText,
        rollbackSteps: rollbackReport.status === 'CRITICAL_MISMATCH'
          ? 'Critical state mismatch detected — manual intervention required before rollback is safe'
          : 'Partial repairs needed post-rollback; see rollback verification report',
      });
      if (rollbackReport.status === 'CRITICAL_MISMATCH') {
        rollbackSteps.push('[rollback] Critical mismatch — resolve corrupted state before rollback');
      } else {
        rollbackSteps.push('[rollback] Partial repairs needed — review repair advice before proceeding');
      }
    } else {
      checks.push({
        category: 'rollback',
        passed: true,
        detail: rollbackReport.summaryText,
      });
    }

    // ── 4. Release gate compatibility ──────────────────────────────────────
    let releaseGateCompatible = true;
    try {
      const gateEval = await this.releaseGate.evaluateReleaseGate(true);
      releaseGateCompatible = gateEval.overallCompatible;
      if (!releaseGateCompatible) {
        checks.push({
          category: 'release-gate',
          passed: false,
          detail: `Release gate status: ${gateEval.gateStatus}. Violations: ${gateEval.violations.join('; ') || 'none'}`,
          rollbackSteps: gateEval.rollbackRecommendations.join('; '),
        });
        for (const rec of gateEval.rollbackRecommendations) {
          rollbackSteps.push(`[release-gate] ${rec}`);
        }
      } else {
        checks.push({
          category: 'release-gate',
          passed: true,
          detail: `Release gate status: ${gateEval.gateStatus}`,
        });
      }
    } catch (error) {
      releaseGateCompatible = false;
      const msg = error instanceof Error ? error.message : String(error);
      checks.push({
        category: 'release-gate',
        passed: false,
        detail: `Release gate evaluation failed: ${msg}`,
        rollbackSteps: 'Ensure contract RPC connectivity and retry',
      });
      rollbackSteps.push('[release-gate] Gate evaluation failed — check RPC connectivity');
    }

    // ── Overall status ─────────────────────────────────────────────────────
    const hasBlocker = checks.some((c) => !c.passed);
    const hasWarning = rollbackReport.status === 'PARTIAL_REPAIR_REQUIRED' && rollbackReport.isClean === false;
    let status: ReadinessStatus = 'READY';
    if (hasBlocker) {
      status = 'BLOCKED';
    } else if (hasWarning) {
      status = 'WARNING';
    }

    const report: ReleaseReadinessReport = {
      status,
      evaluatedAt: new Date().toISOString(),
      dryRun: isDryRun,
      checks,
      migration: migrationReport,
      smokeTests: smokeTestReports,
      rollback: rollbackReport,
      releaseGateCompatible,
      rollbackSteps,
    };

    this.logger.log(`Release readiness evaluation: ${status} (${checks.filter((c) => !c.passed).length} blocker(s))`);
    return report;
  }

  private async evaluateMigrations(dryRun: boolean): Promise<MigrationReadinessReport> {
    const ids = this.migrations.getRegisteredIds();
    const dryRunResults: MigrationReadinessReport['dryRunResults'] = [];

    for (const id of ids) {
      try {
        const report = await this.migrations.run(id, { dryRun: true });
        dryRunResults.push({
          migrationId: id,
          ok: report.ok,
          error: report.error,
          rollbackNotes: report.rollbackNotes,
        });
      } catch (error) {
        dryRunResults.push({
          migrationId: id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      registeredCount: ids.length,
      dryRunResults,
      allPassed: dryRunResults.every((r) => r.ok),
    };
  }

  private async runSmokeTests(probes: SmokeTestProbe[]): Promise<SmokeTestReport[]> {
    const reports: SmokeTestReport[] = [];

    for (const probe of probes) {
      const start = Date.now();
      try {
        const result = await this.withTimeout(probe.run(), probe.timeoutMs);
        reports.push({
          name: probe.name,
          passed: result.passed,
          durationMs: Date.now() - start,
          detail: result.detail,
          timedOut: false,
        });
      } catch (error) {
        const elapsed = Date.now() - start;
        const isTimeout = error instanceof Error && error.message === 'SMOKE_TEST_TIMEOUT';
        reports.push({
          name: probe.name,
          passed: false,
          durationMs: elapsed,
          detail: isTimeout ? `Timed out after ${probe.timeoutMs}ms` : (error instanceof Error ? error.message : String(error)),
          timedOut: isTimeout,
        });
      }
    }

    return reports;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMOKE_TEST_TIMEOUT')), ms);
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  private evaluateRollback(input: RollbackVerificationInput): RollbackReadinessReport {
    const verification = this.rollbackVerifier.verifyRollback(input);
    return {
      status: verification.overallStatus,
      isClean: verification.overallStatus === 'CLEAN',
      repairCount: verification.recordsRequiringRepair.length,
      summaryText: verification.summaryText,
    };
  }
}
