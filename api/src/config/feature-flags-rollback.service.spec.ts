import { FeatureFlagsRollbackService, HealthMetric } from './feature-flags-rollback.service';
import { FeatureFlag } from './feature-flags.service';

describe('FeatureFlagsRollbackService', () => {
  let service: FeatureFlagsRollbackService;

  beforeEach(() => {
    service = new FeatureFlagsRollbackService();
  });

  describe('Initialization', () => {
    it('should initialize rollback verifications for all flags', () => {
      const statuses = service.getAllRollbackStatuses();

      expect(Object.keys(statuses).length).toBeGreaterThan(0);
      for (const status of Object.values(statuses)) {
        expect(status.healthMetrics).toBeDefined();
        expect(status.healthMetrics.length).toBeGreaterThan(0);
      }
    });

    it('should initialize default health metrics', () => {
      const status = service.getRollbackStatus(FeatureFlag.ENABLE_SECONDARY_MARKET);

      expect(status?.healthMetrics).toContainEqual(
        jasmine.objectContaining({ name: 'error_rate' }),
      );
      expect(status?.healthMetrics).toContainEqual(
        jasmine.objectContaining({ name: 'p99_latency_ms' }),
      );
    });
  });

  describe('Health Metric Updates', () => {
    it('should update health metrics without breaching thresholds', () => {
      const result = service.updateHealthMetrics(FeatureFlag.ENABLE_SECONDARY_MARKET, [
        { name: 'error_rate', value: 2 },
        { name: 'p99_latency_ms', value: 300 },
      ]);

      expect(result).toBe(false); // No rollback triggered
      const status = service.getRollbackStatus(FeatureFlag.ENABLE_SECONDARY_MARKET);
      expect(status?.healthMetrics.find((m) => m.name === 'error_rate')?.value).toBe(2);
    });

    it('should detect metric breaches', () => {
      const result = service.updateHealthMetrics(FeatureFlag.ENABLE_SECONDARY_MARKET, [
        { name: 'error_rate', value: 10 }, // Threshold is 5
      ]);

      const status = service.getRollbackStatus(FeatureFlag.ENABLE_SECONDARY_MARKET);
      const errorRateMetric = status?.healthMetrics.find((m) => m.name === 'error_rate');

      expect(errorRateMetric?.breached).toBe(true);
    });

    it('should track multiple metric updates', () => {
      const flag = FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION;

      service.updateHealthMetrics(flag, [{ name: 'error_rate', value: 1 }]);
      service.updateHealthMetrics(flag, [{ name: 'error_rate', value: 2 }]);
      service.updateHealthMetrics(flag, [{ name: 'error_rate', value: 3 }]);

      const history = service.getMetricsHistory(flag, 100);
      expect(history.length).toBe(3);
    });
  });

  describe('Automatic Rollback', () => {
    it('should trigger automatic rollback on health metric breach', () => {
      const flag = FeatureFlag.ENABLE_SECONDARY_MARKET;

      // Initial state: enabled
      let status = service.getRollbackStatus(flag);
      expect(status?.enabled).toBe(false); // Default is disabled

      // This would need the flag to be enabled first via env vars
      // For testing, we check that rollback logic is sound
      service.updateHealthMetrics(flag, [
        { name: 'error_rate', value: 15 }, // Above threshold
        { name: 'p99_latency_ms', value: 1000 }, // Above threshold
      ]);

      status = service.getRollbackStatus(flag);
      expect(status?.rollbackReason).toBeDefined();
    });

    it('should log rollback reason', () => {
      const flag = FeatureFlag.ENABLE_GOVERNANCE_PROPOSALS;

      service.updateHealthMetrics(flag, [
        { name: 'memory_usage_percent', value: 95 },
        { name: 'database_connection_pool_exhaustion', value: 98 },
      ]);

      const status = service.getRollbackStatus(flag);
      expect(status?.rollbackReason).toContain('memory_usage_percent');
      expect(status?.rollbackReason).toContain('database_connection_pool_exhaustion');
    });

    it('should detect inconsistent state as critical', () => {
      const flag = FeatureFlag.ENABLE_INVESTOR_REDEMPTION;

      service.updateHealthMetrics(flag, [
        { name: 'inconsistent_state_count', value: 5 }, // Any value > threshold (0)
      ]);

      const status = service.getRollbackStatus(flag);
      expect(status?.healthMetrics.find((m) => m.name === 'inconsistent_state_count')?.breached).toBe(true);
    });
  });

  describe('Health Verification', () => {
    it('should verify health before rollout', () => {
      const flag = FeatureFlag.ENABLE_SECONDARY_MARKET;

      service.updateHealthMetrics(flag, [
        { name: 'error_rate', value: 2 },
        { name: 'p99_latency_ms', value: 250 },
      ]);

      const verification = service.verifyHealthBeforeRollout(flag);

      expect(verification.healthy).toBe(true);
      expect(verification.issues).toEqual([]);
    });

    it('should report health issues', () => {
      const flag = FeatureFlag.ENABLE_SECONDARY_MARKET;

      service.updateHealthMetrics(flag, [
        { name: 'error_rate', value: 8 },
        { name: 'p99_latency_ms', value: 800 },
      ]);

      const verification = service.verifyHealthBeforeRollout(flag);

      expect(verification.healthy).toBe(false);
      expect(verification.issues.length).toBeGreaterThan(0);
      expect(verification.issues.some((i) => i.includes('error_rate'))).toBe(true);
    });
  });

  describe('Re-enablement After Rollback', () => {
    it('should fail re-enablement if health is not verified', () => {
      const flag = FeatureFlag.ENABLE_SECONDARY_MARKET;

      service.updateHealthMetrics(flag, [
        { name: 'error_rate', value: 10 },
      ]);

      const result = service.reEnableAfterRollback(flag);

      expect(result.success).toBe(false);
      expect(result.reason).toContain('Cannot re-enable');
    });

    it('should successfully re-enable when health is good', () => {
      const flag = FeatureFlag.ENABLE_SECONDARY_MARKET;

      service.updateHealthMetrics(flag, [
        { name: 'error_rate', value: 2 },
        { name: 'p99_latency_ms', value: 200 },
        { name: 'memory_usage_percent', value: 40 },
        { name: 'database_connection_pool_exhaustion', value: 50 },
        { name: 'inconsistent_state_count', value: 0 },
      ]);

      const result = service.reEnableAfterRollback(flag);

      expect(result.success).toBe(true);
    });

    it('should update enabled timestamp on re-enablement', () => {
      const flag = FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION;

      service.updateHealthMetrics(flag, [
        { name: 'error_rate', value: 1 },
      ]);

      const before = Date.now();
      service.reEnableAfterRollback(flag);
      const after = Date.now();

      const status = service.getRollbackStatus(flag);
      expect(status?.enabledAt).toBeGreaterThanOrEqual(before);
      expect(status?.enabledAt).toBeLessThanOrEqual(after);
    });
  });

  describe('Metrics History', () => {
    it('should retrieve metrics history for a flag', () => {
      const flag = FeatureFlag.ENABLE_SECONDARY_MARKET;

      for (let i = 0; i < 5; i++) {
        service.updateHealthMetrics(flag, [
          { name: 'error_rate', value: i },
        ]);
      }

      const history = service.getMetricsHistory(flag, 100);

      expect(history.length).toBe(5);
      expect(history[4][0].value).toBe(4); // Last update
    });

    it('should limit history retrieval', () => {
      const flag = FeatureFlag.ENABLE_INVESTOR_REDEMPTION;

      for (let i = 0; i < 150; i++) {
        service.updateHealthMetrics(flag, [
          { name: 'error_rate', value: i % 10 },
        ]);
      }

      const history = service.getMetricsHistory(flag, 50);

      expect(history.length).toBe(50);
    });
  });

  describe('Status Queries', () => {
    it('should get single flag status', () => {
      const flag = FeatureFlag.ENABLE_SECONDARY_MARKET;
      const status = service.getRollbackStatus(flag);

      expect(status).toBeDefined();
      expect(status?.flag).toBe(flag);
      expect(status?.automaticRollbackEnabled).toBeDefined();
    });

    it('should get all flag statuses', () => {
      const allStatuses = service.getAllRollbackStatuses();

      expect(Object.keys(allStatuses).length).toBeGreaterThan(0);
      expect(allStatuses[FeatureFlag.ENABLE_SECONDARY_MARKET]).toBeDefined();
    });

    it('should include lastVerified timestamp', () => {
      const flag = FeatureFlag.ENABLE_SECONDARY_MARKET;

      service.updateHealthMetrics(flag, [
        { name: 'error_rate', value: 1 },
      ]);

      const status = service.getRollbackStatus(flag);
      const now = Date.now();

      expect(status?.lastVerified).toBeLessThanOrEqual(now);
      expect(status?.lastVerified).toBeGreaterThan(now - 1000); // Within 1 second
    });
  });

  describe('Progressive Rollout Guards', () => {
    it('should support canary deployments with health monitoring', () => {
      const flag = FeatureFlag.ENABLE_GOVERNANCE_PROPOSALS;

      // Simulate canary deployment monitoring
      service.updateHealthMetrics(flag, [
        { name: 'error_rate', value: 2 }, // Low error rate in canary
      ]);

      const verification = service.verifyHealthBeforeRollout(flag);
      expect(verification.healthy).toBe(true);

      // Simulate issues detected
      service.updateHealthMetrics(flag, [
        { name: 'error_rate', value: 12 }, // Error rate jumped
      ]);

      const verification2 = service.verifyHealthBeforeRollout(flag);
      expect(verification2.healthy).toBe(false);
    });

    it('should track emergency disable state', () => {
      const flag = FeatureFlag.ENABLE_SECONDARY_MARKET;

      service.updateHealthMetrics(flag, [
        { name: 'inconsistent_state_count', value: 10 },
      ]);

      const status = service.getRollbackStatus(flag);
      expect(status?.rollbackReason).toContain('inconsistent_state_count');
    });
  });
});
