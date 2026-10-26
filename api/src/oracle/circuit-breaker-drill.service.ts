import { Injectable, Logger, ForbiddenException, BadRequestException } from '@nestjs/common';
import { CircuitBreakerService } from './circuit-breaker.service';
import {
  DrillStepResult,
  DrillStatus,
  DrillExecutionReport,
  UserImpactReport,
} from '../recovery/incident-drill.service';

export type CircuitBreakerDrillType =
  | 'CB_FULL_RECOVERY'
  | 'CB_CROSS_SOURCE'
  | 'CB_BLAST_RADIUS';

const DRILL_PROJECT_ID = 'DRILL-PROJ-CB-001';
const DRILL_GOVERNANCE_ACTOR = 'GOVERNANCE_DRILL_COUNCIL';
const DRILL_MULTISIG = ['SIG_DRILL_ADMIN_1', 'SIG_DRILL_ADMIN_2'];
const DRILL_RESUMPTION_REASON =
  'Drill-verified: oracle anomaly investigated and confirmed as transient sensor miscalibration by multi-source telemetry team';

@Injectable()
export class CircuitBreakerDrillService {
  private readonly logger = new Logger(CircuitBreakerDrillService.name);

  private createIsolatedBreaker(): CircuitBreakerService {
    return new CircuitBreakerService();
  }

  private step(
    name: string,
    startTime: number,
    status: 'SUCCESS' | 'FAILED',
    details: string,
  ): DrillStepResult {
    return { stepName: name, status, durationMs: Date.now() - startTime, details };
  }

  async runFullRecoveryDrill(): Promise<DrillExecutionReport> {
    const drillId = `drill_cb_recovery_${Date.now()}`;
    const startTime = Date.now();
    const steps: DrillStepResult[] = [];
    const breaker = this.createIsolatedBreaker();

    this.logger.log(`[${drillId}] Starting circuit-breaker full recovery drill`);

    let dataValidationPassed = false;
    let recoverySucceeded = false;

    // 1. SEED_HISTORY
    const s1 = Date.now();
    try {
      for (const value of [100, 102, 98, 101, 99]) {
        const result = breaker.evaluateOracleReport({ projectId: DRILL_PROJECT_ID, carbonValue: value });
        if (result.paused) throw new Error('Normal value triggered pause during seeding');
      }
      steps.push(this.step('SEED_HISTORY', s1, 'SUCCESS', 'Seeded 5 trailing observations around mean ~100 tCO2e.'));
    } catch (e: any) {
      steps.push(this.step('SEED_HISTORY', s1, 'FAILED', `Seeding failed: ${e.message}`));
      return this.finalize(drillId, 'CB_FULL_RECOVERY', startTime, steps, dataValidationPassed, recoverySucceeded);
    }

    // 2. INJECT_ANOMALY
    const s2 = Date.now();
    try {
      const anomaly = breaker.evaluateOracleReport({ projectId: DRILL_PROJECT_ID, carbonValue: 9999 });
      if (!anomaly.paused) throw new Error('Anomalous value did not trigger circuit breaker');
      steps.push(this.step('INJECT_ANOMALY', s2, 'SUCCESS',
        `Value 9999 triggered pause. Z-score: ${anomaly.zScore?.toFixed(2)}. Reason: ${anomaly.reason}`));
    } catch (e: any) {
      steps.push(this.step('INJECT_ANOMALY', s2, 'FAILED', `Anomaly injection failed: ${e.message}`));
      return this.finalize(drillId, 'CB_FULL_RECOVERY', startTime, steps, dataValidationPassed, recoverySucceeded);
    }

    // 3. VERIFY_PAUSE
    const s3 = Date.now();
    try {
      if (!breaker.isProjectPaused(DRILL_PROJECT_ID)) throw new Error('Project is not paused after anomaly');
      const state = breaker.getCircuitBreakerState(DRILL_PROJECT_ID);
      if (!state?.triggerReason) throw new Error('Pause state missing trigger reason');
      steps.push(this.step('VERIFY_PAUSE', s3, 'SUCCESS',
        `Project ${DRILL_PROJECT_ID} confirmed paused. Anomaly kind: ${state.anomalyKind}.`));
    } catch (e: any) {
      steps.push(this.step('VERIFY_PAUSE', s3, 'FAILED', `Pause verification failed: ${e.message}`));
    }

    // 4. ATTEMPT_UNAUTHORIZED_RESUME
    const s4 = Date.now();
    try {
      breaker.resumeProject({
        projectId: DRILL_PROJECT_ID,
        governanceActor: 'SINGLE_ADMIN',
        multisigSignatures: ['ONLY_ONE_SIG'],
        resumptionReason: 'Unauthorized single-signer attempt',
      });
      steps.push(this.step('ATTEMPT_UNAUTHORIZED_RESUME', s4, 'FAILED',
        'Resume with single signature should have thrown ForbiddenException'));
    } catch (e: any) {
      if (e instanceof ForbiddenException) {
        steps.push(this.step('ATTEMPT_UNAUTHORIZED_RESUME', s4, 'SUCCESS',
          'Single-signature resume correctly rejected with ForbiddenException.'));
      } else {
        steps.push(this.step('ATTEMPT_UNAUTHORIZED_RESUME', s4, 'FAILED',
          `Expected ForbiddenException, got: ${e.constructor.name}: ${e.message}`));
      }
    }

    // 5. ATTEMPT_INSUFFICIENT_REASON
    const s5 = Date.now();
    try {
      breaker.resumeProject({
        projectId: DRILL_PROJECT_ID,
        governanceActor: DRILL_GOVERNANCE_ACTOR,
        multisigSignatures: DRILL_MULTISIG,
        resumptionReason: 'Short',
      });
      steps.push(this.step('ATTEMPT_INSUFFICIENT_REASON', s5, 'FAILED',
        'Resume with short reason should have thrown BadRequestException'));
    } catch (e: any) {
      if (e instanceof BadRequestException) {
        steps.push(this.step('ATTEMPT_INSUFFICIENT_REASON', s5, 'SUCCESS',
          'Insufficient-reason resume correctly rejected with BadRequestException.'));
      } else {
        steps.push(this.step('ATTEMPT_INSUFFICIENT_REASON', s5, 'FAILED',
          `Expected BadRequestException, got: ${e.constructor.name}: ${e.message}`));
      }
    }

    // 6. GOVERNED_RESUME
    const s6 = Date.now();
    try {
      const resumed = breaker.resumeProject({
        projectId: DRILL_PROJECT_ID,
        governanceActor: DRILL_GOVERNANCE_ACTOR,
        multisigSignatures: DRILL_MULTISIG,
        resumptionReason: DRILL_RESUMPTION_REASON,
      });
      if (resumed.isPaused) throw new Error('Project still paused after governed resume');
      recoverySucceeded = true;
      steps.push(this.step('GOVERNED_RESUME', s6, 'SUCCESS',
        `Project resumed by ${DRILL_GOVERNANCE_ACTOR} with ${DRILL_MULTISIG.length} multisig signatures.`));
    } catch (e: any) {
      steps.push(this.step('GOVERNED_RESUME', s6, 'FAILED', `Governed resume failed: ${e.message}`));
    }

    // 7. VERIFY_RECOVERY
    const s7 = Date.now();
    try {
      if (breaker.isProjectPaused(DRILL_PROJECT_ID)) throw new Error('Project still paused after resume');
      const state = breaker.getCircuitBreakerState(DRILL_PROJECT_ID);
      if (!state) throw new Error('State record missing after resume');
      if (state.resumedBy !== DRILL_GOVERNANCE_ACTOR) {
        throw new Error(`resumedBy mismatch: expected ${DRILL_GOVERNANCE_ACTOR}, got ${state.resumedBy}`);
      }
      if (state.resumptionReason !== DRILL_RESUMPTION_REASON) {
        throw new Error('resumptionReason not recorded correctly');
      }
      dataValidationPassed = true;
      steps.push(this.step('VERIFY_RECOVERY', s7, 'SUCCESS',
        `Recovery verified. resumedBy=${state.resumedBy}, resumedAt=${state.resumedAt}.`));
    } catch (e: any) {
      steps.push(this.step('VERIFY_RECOVERY', s7, 'FAILED', `Recovery verification failed: ${e.message}`));
    }

    // 8. POST_RECOVERY_FEED
    const s8 = Date.now();
    try {
      const postResult = breaker.evaluateOracleReport({ projectId: DRILL_PROJECT_ID, carbonValue: 103 });
      if (postResult.paused) throw new Error('Normal post-recovery value re-triggered pause');
      steps.push(this.step('POST_RECOVERY_FEED', s8, 'SUCCESS',
        'Post-recovery normal value (103) accepted without re-triggering pause.'));
    } catch (e: any) {
      steps.push(this.step('POST_RECOVERY_FEED', s8, 'FAILED', `Post-recovery feed failed: ${e.message}`));
    }

    return this.finalize(drillId, 'CB_FULL_RECOVERY', startTime, steps, dataValidationPassed, recoverySucceeded);
  }

  async runCrossSourceDrill(): Promise<DrillExecutionReport> {
    const drillId = `drill_cb_cross_source_${Date.now()}`;
    const startTime = Date.now();
    const steps: DrillStepResult[] = [];
    const breaker = this.createIsolatedBreaker();
    const projectId = 'DRILL-PROJ-CROSS-001';

    this.logger.log(`[${drillId}] Starting circuit-breaker cross-source drill`);

    let recoverySucceeded = false;
    let dataValidationPassed = false;

    // 1. INJECT_CROSS_SOURCE_ANOMALY
    const s1 = Date.now();
    try {
      const result = breaker.evaluateOracleReport({
        projectId,
        carbonValue: 105,
        crossSourceAssessment: {
          projectId,
          periodKey: '2026-Q3',
          kind: 'conflicting_sources',
          severity: 'critical',
          median: 100,
          deviations: [
            { sourceId: 'satellite-A', value: 105, deviation: 0.05 },
            { sourceId: 'iot-B', value: 40, deviation: 0.6 },
          ],
          tolerance: 0.15,
          reason: 'Critical disagreement between satellite and IoT sensor sources',
        },
      });
      if (!result.paused) throw new Error('Cross-source critical did not trigger pause');
      steps.push(this.step('INJECT_CROSS_SOURCE_ANOMALY', s1, 'SUCCESS',
        `Cross-source critical anomaly triggered pause. Reason: ${result.reason}`));
    } catch (e: any) {
      steps.push(this.step('INJECT_CROSS_SOURCE_ANOMALY', s1, 'FAILED', `Injection failed: ${e.message}`));
      return this.finalize(drillId, 'CB_CROSS_SOURCE', startTime, steps, false, false);
    }

    // 2. VERIFY_CROSS_SOURCE_PAUSE
    const s2 = Date.now();
    try {
      if (!breaker.isProjectPaused(projectId)) throw new Error('Project not paused');
      const state = breaker.getCircuitBreakerState(projectId);
      if (state?.anomalyKind !== 'CROSS_SOURCE_CRITICAL') {
        throw new Error(`Expected CROSS_SOURCE_CRITICAL, got ${state?.anomalyKind}`);
      }
      steps.push(this.step('VERIFY_CROSS_SOURCE_PAUSE', s2, 'SUCCESS',
        `Pause verified with anomalyKind=${state.anomalyKind}.`));
    } catch (e: any) {
      steps.push(this.step('VERIFY_CROSS_SOURCE_PAUSE', s2, 'FAILED', e.message));
    }

    // 3. GOVERNED_RESUME
    const s3 = Date.now();
    try {
      const resumed = breaker.resumeProject({
        projectId,
        governanceActor: DRILL_GOVERNANCE_ACTOR,
        multisigSignatures: DRILL_MULTISIG,
        resumptionReason: 'Cross-source drill: IoT sensor B recalibrated and independently verified against satellite data',
      });
      recoverySucceeded = !resumed.isPaused;
      dataValidationPassed = recoverySucceeded;
      steps.push(this.step('GOVERNED_RESUME', s3, recoverySucceeded ? 'SUCCESS' : 'FAILED',
        recoverySucceeded ? 'Cross-source pause resolved by governed resume.' : 'Resume did not clear pause.'));
    } catch (e: any) {
      steps.push(this.step('GOVERNED_RESUME', s3, 'FAILED', `Resume failed: ${e.message}`));
    }

    return this.finalize(drillId, 'CB_CROSS_SOURCE', startTime, steps, dataValidationPassed, recoverySucceeded);
  }

  async runBlastRadiusDrill(): Promise<DrillExecutionReport> {
    const drillId = `drill_cb_blast_radius_${Date.now()}`;
    const startTime = Date.now();
    const steps: DrillStepResult[] = [];
    const breaker = this.createIsolatedBreaker();

    const projectA = 'DRILL-PROJ-A';
    const trancheT1 = 'GREEN_INSTITUTIONAL';
    const trancheT2 = 'STANDARD_RETAIL';
    const projectB = 'DRILL-PROJ-B';

    this.logger.log(`[${drillId}] Starting circuit-breaker blast-radius isolation drill`);

    let recoverySucceeded = false;
    let dataValidationPassed = false;

    // 1. TRIGGER_SCOPED_PAUSE
    const s1 = Date.now();
    try {
      breaker.triggerScopedPause({
        projectId: projectA,
        tranche: trancheT1,
        reason: 'Drill: institutional tranche anomaly',
        anomalyKind: 'TRANCHE_SPECIFIC_DRILL',
      });
      if (!breaker.isProjectPaused(projectA, trancheT1)) throw new Error('Tranche T1 not paused');
      steps.push(this.step('TRIGGER_SCOPED_PAUSE', s1, 'SUCCESS',
        `Scoped pause activated for ${projectA}:${trancheT1}.`));
    } catch (e: any) {
      steps.push(this.step('TRIGGER_SCOPED_PAUSE', s1, 'FAILED', `Scoped pause failed: ${e.message}`));
      return this.finalize(drillId, 'CB_BLAST_RADIUS', startTime, steps, false, false);
    }

    // 2. VERIFY_T2_UNAFFECTED
    const s2 = Date.now();
    try {
      if (breaker.isProjectPaused(projectA, trancheT2)) {
        throw new Error(`Tranche ${trancheT2} is paused — blast radius leak`);
      }
      steps.push(this.step('VERIFY_T2_UNAFFECTED', s2, 'SUCCESS',
        `Tranche ${trancheT2} confirmed unaffected by ${trancheT1} pause.`));
    } catch (e: any) {
      steps.push(this.step('VERIFY_T2_UNAFFECTED', s2, 'FAILED', e.message));
    }

    // 3. VERIFY_PROJECT_B_UNAFFECTED
    const s3 = Date.now();
    try {
      if (breaker.isProjectPaused(projectB)) {
        throw new Error(`Project ${projectB} is paused — cross-project blast radius leak`);
      }
      steps.push(this.step('VERIFY_PROJECT_B_UNAFFECTED', s3, 'SUCCESS',
        `Project ${projectB} confirmed unaffected by ${projectA} pause.`));
    } catch (e: any) {
      steps.push(this.step('VERIFY_PROJECT_B_UNAFFECTED', s3, 'FAILED', e.message));
    }

    // 4. RESUME_AND_VERIFY
    const s4 = Date.now();
    try {
      const resumed = breaker.resumeProject({
        projectId: projectA,
        tranche: trancheT1,
        governanceActor: DRILL_GOVERNANCE_ACTOR,
        multisigSignatures: DRILL_MULTISIG,
        resumptionReason: 'Blast-radius drill: scoped pause confirmed isolated; resuming after verification',
      });
      if (resumed.isPaused) throw new Error('Tranche still paused after resume');
      recoverySucceeded = true;
      dataValidationPassed = true;
      steps.push(this.step('RESUME_AND_VERIFY', s4, 'SUCCESS',
        `${projectA}:${trancheT1} resumed. Blast radius contained throughout drill.`));
    } catch (e: any) {
      steps.push(this.step('RESUME_AND_VERIFY', s4, 'FAILED', `Resume failed: ${e.message}`));
    }

    return this.finalize(drillId, 'CB_BLAST_RADIUS', startTime, steps, dataValidationPassed, recoverySucceeded);
  }

  async runAllDrills(): Promise<{
    suiteTimestamp: string;
    overallStatus: DrillStatus;
    totalDurationMs: number;
    drills: DrillExecutionReport[];
  }> {
    const start = Date.now();
    const drills: DrillExecutionReport[] = [];

    drills.push(await this.runFullRecoveryDrill());
    drills.push(await this.runCrossSourceDrill());
    drills.push(await this.runBlastRadiusDrill());

    const hasFailure = drills.some((d) => d.status === 'FAILED');

    return {
      suiteTimestamp: new Date().toISOString(),
      overallStatus: hasFailure ? 'FAILED' : 'PASSED',
      totalDurationMs: Date.now() - start,
      drills,
    };
  }

  private finalize(
    drillId: string,
    drillType: CircuitBreakerDrillType,
    startTime: number,
    steps: DrillStepResult[],
    dataValidationPassed: boolean,
    recoverySucceeded: boolean,
  ): DrillExecutionReport {
    const hasFailure = steps.some((s) => s.status === 'FAILED');

    const userImpact: UserImpactReport = {
      impactSeverity: 'LOW',
      affectedUsersCount: 0,
      affectedEntityIds: [drillId],
      totalFinancialExposureUSD: 0,
      slaBreachRisk: false,
      userFacingMessage: 'Circuit breaker recovery drill executed in isolated sandbox — no production impact.',
      remediationSummary: hasFailure
        ? 'Drill revealed a gap in the circuit-breaker recovery path. Review failed steps.'
        : 'All circuit-breaker recovery steps verified successfully.',
    };

    return {
      drillId,
      drillType: drillType as any,
      timestamp: new Date().toISOString(),
      status: hasFailure ? 'FAILED' : 'PASSED',
      durationMs: Date.now() - startTime,
      steps,
      dataValidationPassed,
      rollbackSucceeded: false,
      recoverySucceeded,
      userImpact,
    };
  }
}
