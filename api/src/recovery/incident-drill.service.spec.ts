import { IncidentDrillService } from './incident-drill.service';
import { RollbackVerificationService } from './rollback-verification.service';
import { BondStateMachine, CouponStateMachine, SettlementStateMachine } from '../bonds/bond.state-machine';

describe('IncidentDrillService (#356 Incident Drill & Verification)', () => {
  let drillService: IncidentDrillService;
  let rollbackVerifier: RollbackVerificationService;

  beforeEach(() => {
    rollbackVerifier = new RollbackVerificationService();
    drillService = new IncidentDrillService(
      rollbackVerifier,
      new BondStateMachine(),
      new CouponStateMachine(),
      new SettlementStateMachine(),
    );
  });

  describe('Green Bond Issuance Failure & Rollback Drill', () => {
    it('executes fault injection, rollback to CANCELLED, data validation, and generates user impact report', async () => {
      const report = await drillService.runBondIssuanceRollbackDrill();

      expect(report.drillType).toBe('BOND_ISSUANCE_ROLLBACK');
      expect(report.status).toBe('PASSED');
      expect(report.rollbackSucceeded).toBe(true);
      expect(report.dataValidationPassed).toBe(true);
      expect(report.steps.length).toBeGreaterThanOrEqual(3);

      const rollbackStep = report.steps.find((s) => s.stepName === 'EXECUTE_EMERGENCY_ROLLBACK');
      expect(rollbackStep).toBeDefined();
      expect(rollbackStep!.status).toBe('SUCCESS');

      // User impact verification
      expect(report.userImpact.impactSeverity).toBe('MEDIUM');
      expect(report.userImpact.affectedUsersCount).toBe(14);
      expect(report.userImpact.totalFinancialExposureUSD).toBe(250000);
      expect(report.userImpact.userFacingMessage).toContain('safely cancelled before settlement');
    });
  });

  describe('Carbon Credit Coupon Distribution Halt & Oracle Recovery Drill', () => {
    it('executes oracle drift detection, multi-source reconciliation, and distribution completion', async () => {
      const report = await drillService.runCouponOracleRecoveryDrill();

      expect(report.drillType).toBe('COUPON_ORACLE_RECOVERY');
      expect(report.status).toBe('PASSED');
      expect(report.recoverySucceeded).toBe(true);
      expect(report.dataValidationPassed).toBe(true);

      const recoveryStep = report.steps.find((s) => s.stepName === 'EXECUTE_ORACLE_RECONCILIATION_RECOVERY');
      expect(recoveryStep).toBeDefined();
      expect(recoveryStep!.status).toBe('SUCCESS');

      expect(report.userImpact.affectedUsersCount).toBe(42);
      expect(report.userImpact.remediationSummary).toContain('Oracle consensus verified');
    });
  });

  describe('Secondary-Market Settlement Deadlock & Escrow Rollback Drill', () => {
    it('executes deadlock detection, atomic escrow rollback, and zero-leakage invariant verification', async () => {
      const report = await drillService.runSettlementDeadlockRollbackDrill();

      expect(report.drillType).toBe('SETTLEMENT_DEADLOCK_ROLLBACK');
      expect(report.status).toBe('PASSED');
      expect(report.rollbackSucceeded).toBe(true);
      expect(report.dataValidationPassed).toBe(true);

      const escrowStep = report.steps.find((s) => s.stepName === 'EXECUTE_ATOMIC_ESCROW_ROLLBACK');
      expect(escrowStep).toBeDefined();
      expect(escrowStep!.status).toBe('SUCCESS');

      expect(report.userImpact.affectedUsersCount).toBe(2);
      expect(report.userImpact.totalFinancialExposureUSD).toBe(50000);
    });
  });

  describe('Comprehensive Incident Drill Suite', () => {
    it('executes all three mission-critical drills and returns overall PASSED status', async () => {
      const suiteReport = await drillService.runAllDrills();

      expect(suiteReport.overallStatus).toBe('PASSED');
      expect(suiteReport.drills).toHaveLength(3);
      expect(suiteReport.drills.every((d) => d.status === 'PASSED')).toBe(true);
    });
  });
});
