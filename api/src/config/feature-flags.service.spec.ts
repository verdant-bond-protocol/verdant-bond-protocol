import { Test, TestingModule } from '@nestjs/testing';
import { FeatureFlagsService, FeatureFlag, FeatureFlagStatus } from './feature-flags.service';

describe('FeatureFlagsService — Feature Rollout Guardrails (#425)', () => {
  let service: FeatureFlagsService;
  const originalEnv = process.env;

  beforeEach(async () => {
    jest.resetModules();
    process.env = { ...originalEnv };

    const module: TestingModule = await Test.createTestingModule({
      providers: [FeatureFlagsService],
    }).compile();

    service = module.get<FeatureFlagsService>(FeatureFlagsService);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Safe defaults and initialization', () => {
    it('should initialize all flags as disabled by default', () => {
      const flags = service.getAllFlags();
      expect(flags[FeatureFlag.ENABLE_SECONDARY_MARKET].status).toBe(FeatureFlagStatus.DISABLED);
      expect(flags[FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION].status).toBe(FeatureFlagStatus.DISABLED);
      expect(flags[FeatureFlag.ENABLE_INVESTOR_REDEMPTION].status).toBe(FeatureFlagStatus.DISABLED);
      expect(flags[FeatureFlag.ENABLE_GOVERNANCE_PROPOSALS].status).toBe(FeatureFlagStatus.DISABLED);
    });

    it('should return false for disabled flags', () => {
      expect(service.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET)).toBe(false);
    });
  });

  describe('Normal rollout path', () => {
    it('should enable a feature and report enabled status', () => {
      service.enableFeature(FeatureFlag.ENABLE_SECONDARY_MARKET, 'Ready for production');
      expect(service.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET)).toBe(true);
    });

    it('should audit feature enablement with timestamp and reason', () => {
      service.enableFeature(FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION, 'Q4 2026 rollout');
      const log = service.getFlagAuditLog(FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION);
      expect(log).toHaveLength(1);
      expect(log[0]).toEqual(
        expect.objectContaining({
          action: 'enabled',
          reason: 'Q4 2026 rollout',
        }),
      );
      expect(log[0].timestamp).toBeDefined();
    });
  });

  describe('Canary deployment path', () => {
    it('should enable feature in canary mode with 10% sampling', () => {
      service.enableFeatureCanary(FeatureFlag.ENABLE_INVESTOR_REDEMPTION, 'Testing with 10% of users');

      // Sample users: some enabled, some disabled
      const enabled = [];
      const disabled = [];
      for (let i = 0; i < 100; i++) {
        const userId = `user-${i}`;
        if (service.isEnabled(FeatureFlag.ENABLE_INVESTOR_REDEMPTION, userId)) {
          enabled.push(userId);
        } else {
          disabled.push(userId);
        }
      }

      // Expect approximately 10% enabled (with some variance for small N)
      expect(enabled.length).toBeGreaterThan(0);
      expect(enabled.length).toBeLessThanOrEqual(20); // Allow 5-15% variance
    });

    it('should audit canary rollout separately from normal rollout', () => {
      service.enableFeatureCanary(FeatureFlag.ENABLE_GOVERNANCE_PROPOSALS, 'Internal testing');
      const log = service.getFlagAuditLog(FeatureFlag.ENABLE_GOVERNANCE_PROPOSALS);
      expect(log[0].action).toBe('enabled_canary');
    });

    it('should return false for canary-disabled users without userId', () => {
      service.enableFeatureCanary(FeatureFlag.ENABLE_SECONDARY_MARKET);
      expect(service.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET)).toBe(false); // No userId = no sampling
      expect(service.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET, 'user-123')).toBeDefined(); // With userId
    });
  });

  describe('Failure path — immediate disablement', () => {
    it('should disable a feature immediately', () => {
      service.enableFeature(FeatureFlag.ENABLE_SECONDARY_MARKET);
      expect(service.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET)).toBe(true);

      service.disableFeature(FeatureFlag.ENABLE_SECONDARY_MARKET, 'Critical bug detected');
      expect(service.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET)).toBe(false);
    });

    it('should record disablement reason in audit log', () => {
      service.enableFeature(FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION);
      service.disableFeature(FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION, 'Unexpected contract revert');

      const log = service.getFlagAuditLog(FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION);
      expect(log).toHaveLength(2);
      expect(log[1]).toEqual(
        expect.objectContaining({
          action: 'disabled',
          reason: 'Unexpected contract revert',
        }),
      );
    });
  });

  describe('Emergency disablement path', () => {
    it('should emergency-disable a feature (status = EMERGENCY)', () => {
      service.enableFeature(FeatureFlag.ENABLE_INVESTOR_REDEMPTION);
      service.emergencyDisable(FeatureFlag.ENABLE_INVESTOR_REDEMPTION, 'Network degradation detected');

      expect(service.isEnabled(FeatureFlag.ENABLE_INVESTOR_REDEMPTION)).toBe(false);
    });

    it('should audit emergency disablement with EMERGENCY marker', () => {
      service.enableFeature(FeatureFlag.ENABLE_GOVERNANCE_PROPOSALS);
      service.emergencyDisable(FeatureFlag.ENABLE_GOVERNANCE_PROPOSALS, 'Contract exploit attempt');

      const log = service.getFlagAuditLog(FeatureFlag.ENABLE_GOVERNANCE_PROPOSALS);
      const emergencyEntry = log.find((e) => e.action === 'emergency_disabled');
      expect(emergencyEntry).toBeDefined();
      expect(emergencyEntry?.reason).toBe('Contract exploit attempt');
    });

    it('should mark emergency-disabled flags with emergencyDisabledAt timestamp', () => {
      service.enableFeature(FeatureFlag.ENABLE_SECONDARY_MARKET);
      service.emergencyDisable(FeatureFlag.ENABLE_SECONDARY_MARKET);

      const flags = service.getAllFlags();
      expect(flags[FeatureFlag.ENABLE_SECONDARY_MARKET].status).toBe(FeatureFlagStatus.EMERGENCY);
      expect(flags[FeatureFlag.ENABLE_SECONDARY_MARKET].emergencyDisabledAt).toBeDefined();
    });
  });

  describe('Retry path — safe re-enablement', () => {
    it('should allow re-enabling a feature after disablement', () => {
      service.enableFeature(FeatureFlag.ENABLE_SECONDARY_MARKET);
      service.disableFeature(FeatureFlag.ENABLE_SECONDARY_MARKET, 'Testing disablement');

      expect(service.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET)).toBe(false);

      service.enableFeature(FeatureFlag.ENABLE_SECONDARY_MARKET, 'Bug fix deployed, re-enabling');
      expect(service.isEnabled(FeatureFlag.ENABLE_SECONDARY_MARKET)).toBe(true);
    });

    it('should preserve audit trail across enable/disable cycles', () => {
      service.enableFeature(FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION, 'Initial rollout');
      service.disableFeature(FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION, 'Rollback for bug fix');
      service.enableFeature(FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION, 'Re-enabled after fix');

      const log = service.getFlagAuditLog(FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION);
      expect(log).toHaveLength(3);
      expect(log.map((e) => e.action)).toEqual(['enabled', 'disabled', 'enabled']);
    });
  });

  describe('Authorization path — audit trail access', () => {
    it('should return read-only audit log', () => {
      service.enableFeature(FeatureFlag.ENABLE_INVESTOR_REDEMPTION);
      const log = service.getAuditLog();

      // Verify read-only by attempting mutation (should not affect actual log)
      log.push({
        timestamp: '2026-12-01T00:00:00Z',
        flag: FeatureFlag.ENABLE_INVESTOR_REDEMPTION,
        action: 'malicious',
      } as any);

      const liveLog = service.getAuditLog();
      expect(liveLog.find((e) => e.action === 'malicious')).toBeUndefined();
    });

    it('should get audit log for a specific flag only', () => {
      service.enableFeature(FeatureFlag.ENABLE_SECONDARY_MARKET);
      service.enableFeature(FeatureFlag.ENABLE_AUTO_COUPON_DISTRIBUTION);

      const log = service.getFlagAuditLog(FeatureFlag.ENABLE_SECONDARY_MARKET);
      expect(log.every((e) => e.flag === FeatureFlag.ENABLE_SECONDARY_MARKET)).toBe(true);
    });
  });

  describe('Edge cases and rollback scenarios', () => {
    it('should handle rapid enable/disable cycles', () => {
      const flag = FeatureFlag.ENABLE_GOVERNANCE_PROPOSALS;
      for (let i = 0; i < 5; i++) {
        service.enableFeature(flag);
        service.disableFeature(flag, `Cycle ${i}`);
      }

      const log = service.getFlagAuditLog(flag);
      expect(log).toHaveLength(10); // 5 enables + 5 disables
    });

    it('should differentiate between normal disablement and emergency disablement in audit', () => {
      service.enableFeature(FeatureFlag.ENABLE_SECONDARY_MARKET);
      service.disableFeature(FeatureFlag.ENABLE_SECONDARY_MARKET, 'Planned maintenance');
      service.enableFeature(FeatureFlag.ENABLE_SECONDARY_MARKET);
      service.emergencyDisable(FeatureFlag.ENABLE_SECONDARY_MARKET, 'Security incident');

      const log = service.getFlagAuditLog(FeatureFlag.ENABLE_SECONDARY_MARKET);
      const actions = log.map((e) => e.action);
      expect(actions).toEqual(['enabled', 'disabled', 'enabled', 'emergency_disabled']);
    });
  });

  describe('Canary to full rollout promotion', () => {
    it('should support progression from canary to full rollout', () => {
      service.enableFeatureCanary(FeatureFlag.ENABLE_INVESTOR_REDEMPTION, 'Phase 1');
      // Verify canary is active
      expect(service.getAllFlags()[FeatureFlag.ENABLE_INVESTOR_REDEMPTION].canary).toBe(true);

      // Promote to full
      service.disableFeature(FeatureFlag.ENABLE_INVESTOR_REDEMPTION);
      service.enableFeature(FeatureFlag.ENABLE_INVESTOR_REDEMPTION, 'Phase 2 - full rollout');

      // Now all users are enabled, not just 10%
      expect(service.isEnabled(FeatureFlag.ENABLE_INVESTOR_REDEMPTION, 'random-user')).toBe(true);
      expect(service.getAllFlags()[FeatureFlag.ENABLE_INVESTOR_REDEMPTION].canary).toBe(false);
    });
  });
});
