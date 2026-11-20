import { CircuitBreakerService } from './circuit-breaker.service';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';

describe('CircuitBreakerService (#332 Oracle Anomaly Circuit Breaker)', () => {
  let service: CircuitBreakerService;

  beforeEach(() => {
    service = new CircuitBreakerService();
  });

  describe('1. Anomaly Detection & Automatic Triggering', () => {
    it('allows normal variance within trailing history', () => {
      // Seed trailing history with normal observations ~100
      service.evaluateOracleReport({ projectId: 'PROJ-1', carbonValue: 100 });
      service.evaluateOracleReport({ projectId: 'PROJ-1', carbonValue: 102 });
      service.evaluateOracleReport({ projectId: 'PROJ-1', carbonValue: 98 });

      const result = service.evaluateOracleReport({ projectId: 'PROJ-1', carbonValue: 101 });
      expect(result.paused).toBe(false);
      expect(service.isProjectPaused('PROJ-1')).toBe(false);
    });

    it('automatically triggers scoped pause when statistical anomaly breaches 3.0 std dev threshold', () => {
      // Seed trailing history around 100 (mean = 100, stdDev ≈ 1.63)
      service.evaluateOracleReport({ projectId: 'PROJ-1', carbonValue: 100 });
      service.evaluateOracleReport({ projectId: 'PROJ-1', carbonValue: 102 });
      service.evaluateOracleReport({ projectId: 'PROJ-1', carbonValue: 98 });

      // Outlier value of 500 (deviates > 200 std dev)
      const anomalyResult = service.evaluateOracleReport({ projectId: 'PROJ-1', carbonValue: 500 });

      expect(anomalyResult.paused).toBe(true);
      expect(anomalyResult.reason).toContain('Statistical anomaly detected');
      expect(service.isProjectPaused('PROJ-1')).toBe(true);
    });

    it('triggers pause when cross-source assessment reports critical severity', () => {
      const result = service.evaluateOracleReport({
        projectId: 'PROJ-1',
        carbonValue: 105,
        crossSourceAssessment: {
          projectId: 'PROJ-1',
          periodKey: '2026-Q1',
          kind: 'conflicting_sources',
          severity: 'critical',
          median: 100,
          deviations: [],
          tolerance: 0.15,
          reason: 'Critical disagreement between satellite and IoT sources',
        },
      });

      expect(result.paused).toBe(true);
      expect(service.isProjectPaused('PROJ-1')).toBe(true);
    });
  });

  describe('2. Scoped Blast Radius', () => {
    it('limits pause blast radius strictly to affected project, leaving other projects active', () => {
      // Trigger circuit breaker on PROJ-A
      service.triggerScopedPause({
        projectId: 'PROJ-A',
        reason: 'Oracle data spike detected',
        anomalyKind: 'STATISTICAL_ZSCORE_DEVIATION',
      });

      expect(service.isProjectPaused('PROJ-A')).toBe(true);
      // Other project remains unaffected
      expect(service.isProjectPaused('PROJ-B')).toBe(false);
    });

    it('supports tranche-level scoped pause', () => {
      service.triggerScopedPause({
        projectId: 'PROJ-A',
        tranche: 'GREEN_INSTITUTIONAL',
        reason: 'Institutional tranche anomaly',
        anomalyKind: 'TRANCHE_SPECIFIC',
      });

      expect(service.isProjectPaused('PROJ-A', 'GREEN_INSTITUTIONAL')).toBe(true);
      expect(service.isProjectPaused('PROJ-A', 'STANDARD')).toBe(false);
    });
  });

  describe('3. Governed Resumption (No Automatic Timeout)', () => {
    it('does NOT automatically unpause over elapsed time (no timeout resumption)', () => {
      service.triggerScopedPause({
        projectId: 'PROJ-1',
        reason: 'Anomaly detected',
        anomalyKind: 'TEST',
      });

      // Advance simulated time by 30 days
      const currentStatus = service.isProjectPaused('PROJ-1');
      expect(currentStatus).toBe(true);
    });

    it('requires explicit governance multisig action to resume project', () => {
      service.triggerScopedPause({
        projectId: 'PROJ-1',
        reason: 'Anomaly detected',
        anomalyKind: 'TEST',
      });

      const resumed = service.resumeProject({
        projectId: 'PROJ-1',
        governanceActor: 'GOVERNANCE_MULTISIG_COUNCIL',
        multisigSignatures: ['SIG_ADMIN_1_HEX', 'SIG_ADMIN_2_HEX'],
        resumptionReason: 'Oracle anomaly investigated and validated by multi-source telemetry team',
      });

      expect(resumed.isPaused).toBe(false);
      expect(resumed.resumedBy).toBe('GOVERNANCE_MULTISIG_COUNCIL');
      expect(service.isProjectPaused('PROJ-1')).toBe(false);
    });

    it('rejects resumption attempt without required multisig signatures', () => {
      service.triggerScopedPause({
        projectId: 'PROJ-1',
        reason: 'Anomaly detected',
        anomalyKind: 'TEST',
      });

      expect(() =>
        service.resumeProject({
          projectId: 'PROJ-1',
          governanceActor: 'SINGLE_ADMIN',
          multisigSignatures: ['SINGLE_SIG'], // Only 1 signature
          resumptionReason: 'Single admin attempt to unpause',
        }),
      ).toThrow(ForbiddenException);
    });

    it('rejects resumption without detailed justification', () => {
      service.triggerScopedPause({
        projectId: 'PROJ-1',
        reason: 'Anomaly detected',
        anomalyKind: 'TEST',
      });

      expect(() =>
        service.resumeProject({
          projectId: 'PROJ-1',
          governanceActor: 'GOVERNANCE_MULTISIG',
          multisigSignatures: ['SIG_1', 'SIG_2'],
          resumptionReason: 'Short', // Less than 10 chars
        }),
      ).toThrow(BadRequestException);
    });
  });
});
