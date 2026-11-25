import { CircuitBreakerDrillService } from './circuit-breaker-drill.service';

describe('CircuitBreakerDrillService (#470 Circuit-Breaker Recovery Drill)', () => {
  let drill: CircuitBreakerDrillService;

  beforeEach(() => {
    drill = new CircuitBreakerDrillService();
  });

  describe('Full Recovery Drill', () => {
    it('passes all 8 steps of the full anomaly → pause → reject → resume → verify lifecycle', async () => {
      const report = await drill.runFullRecoveryDrill();

      expect(report.status).toBe('PASSED');
      expect(report.steps).toHaveLength(8);
      expect(report.recoverySucceeded).toBe(true);
      expect(report.dataValidationPassed).toBe(true);

      const stepNames = report.steps.map((s) => s.stepName);
      expect(stepNames).toEqual([
        'SEED_HISTORY',
        'INJECT_ANOMALY',
        'VERIFY_PAUSE',
        'ATTEMPT_UNAUTHORIZED_RESUME',
        'ATTEMPT_INSUFFICIENT_REASON',
        'GOVERNED_RESUME',
        'VERIFY_RECOVERY',
        'POST_RECOVERY_FEED',
      ]);

      for (const step of report.steps) {
        expect(step.status).toBe('SUCCESS');
        expect(step.durationMs).toBeGreaterThanOrEqual(0);
        expect(step.details.length).toBeGreaterThan(0);
      }
    });

    it('records z-score in the INJECT_ANOMALY step details', async () => {
      const report = await drill.runFullRecoveryDrill();
      const anomalyStep = report.steps.find((s) => s.stepName === 'INJECT_ANOMALY')!;
      expect(anomalyStep.details).toContain('Z-score:');
    });

    it('verifies resumedBy and resumptionReason in VERIFY_RECOVERY step', async () => {
      const report = await drill.runFullRecoveryDrill();
      const verifyStep = report.steps.find((s) => s.stepName === 'VERIFY_RECOVERY')!;
      expect(verifyStep.status).toBe('SUCCESS');
      expect(verifyStep.details).toContain('GOVERNANCE_DRILL_COUNCIL');
    });

    it('confirms post-recovery feed does not re-trigger the breaker', async () => {
      const report = await drill.runFullRecoveryDrill();
      const postStep = report.steps.find((s) => s.stepName === 'POST_RECOVERY_FEED')!;
      expect(postStep.status).toBe('SUCCESS');
      expect(postStep.details).toContain('accepted without re-triggering');
    });

    it('uses an isolated CircuitBreakerService per drill run (no shared state)', async () => {
      const report1 = await drill.runFullRecoveryDrill();
      const report2 = await drill.runFullRecoveryDrill();

      expect(report1.status).toBe('PASSED');
      expect(report2.status).toBe('PASSED');
      expect(report1.drillId).not.toBe(report2.drillId);
    });

    it('includes user impact with zero production exposure', async () => {
      const report = await drill.runFullRecoveryDrill();

      expect(report.userImpact.impactSeverity).toBe('LOW');
      expect(report.userImpact.affectedUsersCount).toBe(0);
      expect(report.userImpact.totalFinancialExposureUSD).toBe(0);
      expect(report.userImpact.slaBreachRisk).toBe(false);
    });
  });

  describe('Cross-Source Drill', () => {
    it('passes all steps for cross-source critical anomaly → governed resume', async () => {
      const report = await drill.runCrossSourceDrill();

      expect(report.status).toBe('PASSED');
      expect(report.recoverySucceeded).toBe(true);
      expect(report.dataValidationPassed).toBe(true);

      const stepNames = report.steps.map((s) => s.stepName);
      expect(stepNames).toEqual([
        'INJECT_CROSS_SOURCE_ANOMALY',
        'VERIFY_CROSS_SOURCE_PAUSE',
        'GOVERNED_RESUME',
      ]);

      for (const step of report.steps) {
        expect(step.status).toBe('SUCCESS');
      }
    });

    it('verifies the anomaly kind is CROSS_SOURCE_CRITICAL', async () => {
      const report = await drill.runCrossSourceDrill();
      const verifyStep = report.steps.find((s) => s.stepName === 'VERIFY_CROSS_SOURCE_PAUSE')!;
      expect(verifyStep.details).toContain('CROSS_SOURCE_CRITICAL');
    });
  });

  describe('Blast Radius Drill', () => {
    it('passes all steps verifying tranche and project isolation', async () => {
      const report = await drill.runBlastRadiusDrill();

      expect(report.status).toBe('PASSED');
      expect(report.recoverySucceeded).toBe(true);
      expect(report.dataValidationPassed).toBe(true);

      const stepNames = report.steps.map((s) => s.stepName);
      expect(stepNames).toEqual([
        'TRIGGER_SCOPED_PAUSE',
        'VERIFY_T2_UNAFFECTED',
        'VERIFY_PROJECT_B_UNAFFECTED',
        'RESUME_AND_VERIFY',
      ]);

      for (const step of report.steps) {
        expect(step.status).toBe('SUCCESS');
      }
    });

    it('confirms tranche-level isolation: T2 is not paused when T1 is', async () => {
      const report = await drill.runBlastRadiusDrill();
      const t2Step = report.steps.find((s) => s.stepName === 'VERIFY_T2_UNAFFECTED')!;
      expect(t2Step.status).toBe('SUCCESS');
      expect(t2Step.details).toContain('unaffected');
    });

    it('confirms cross-project isolation: project B is unaffected', async () => {
      const report = await drill.runBlastRadiusDrill();
      const projBStep = report.steps.find((s) => s.stepName === 'VERIFY_PROJECT_B_UNAFFECTED')!;
      expect(projBStep.status).toBe('SUCCESS');
      expect(projBStep.details).toContain('unaffected');
    });
  });

  describe('Full Suite', () => {
    it('runs all three drills and reports overall PASSED', async () => {
      const suite = await drill.runAllDrills();

      expect(suite.overallStatus).toBe('PASSED');
      expect(suite.drills).toHaveLength(3);
      expect(suite.totalDurationMs).toBeGreaterThanOrEqual(0);

      for (const drillReport of suite.drills) {
        expect(drillReport.status).toBe('PASSED');
      }
    });
  });

  describe('Drill Report Structure', () => {
    it('populates all required DrillExecutionReport fields', async () => {
      const report = await drill.runFullRecoveryDrill();

      expect(report.drillId).toMatch(/^drill_cb_recovery_\d+$/);
      expect(report.timestamp).toBeDefined();
      expect(typeof report.durationMs).toBe('number');
      expect(report.rollbackSucceeded).toBe(false);
      expect(report.userImpact).toBeDefined();
      expect(report.userImpact.userFacingMessage).toContain('no production impact');
    });

    it('each step has a non-negative durationMs', async () => {
      const report = await drill.runFullRecoveryDrill();

      for (const step of report.steps) {
        expect(step.durationMs).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
