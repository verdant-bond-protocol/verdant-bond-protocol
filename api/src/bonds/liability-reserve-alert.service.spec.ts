import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  LiabilityReserveAlertService,
  LiabilityReserveAlertRecord,
} from './liability-reserve-alert.service';
import { NotificationsService } from '../notifications/notifications.service';

describe('LiabilityReserveAlertService', () => {
  let service: LiabilityReserveAlertService;
  let notificationsService: Partial<NotificationsService>;
  let dispatchedNotifications: any[];

  beforeEach(() => {
    dispatchedNotifications = [];
    notificationsService = {
      createNotification: jest.fn().mockImplementation((data) => {
        dispatchedNotifications.push(data);
        return { id: 'mock-notif-id', ...data, createdAt: new Date() };
      }),
    };

    service = new LiabilityReserveAlertService(
      notificationsService as NotificationsService,
      undefined,
      {
        warningThresholdBps: 9000,
        criticalThresholdBps: 8000,
        emergencyThresholdBps: 5000,
      },
    );
  });

  describe('Normal Path', () => {
    it('should trigger WARNING alert when reserves are between 80% and 90% of liabilities', async () => {
      const alert = await service.evaluateFunding(
        101,
        10_000_000n, // Liabilities
        8_500_000n,  // Reserves (85% -> 8500 bps)
        'Quarterly stress test',
      );

      expect(alert).not.toBeNull();
      expect(alert!.bondId).toBe(101);
      expect(alert!.totalLiabilities).toBe('10000000');
      expect(alert!.availableReserves).toBe('8500000');
      expect(alert!.shortfall).toBe('1500000');
      expect(alert!.coverageBps).toBe(8500);
      expect(alert!.severity).toBe('WARNING');
      expect(alert!.status).toBe('ACTIVE');
      expect(alert!.retryCount).toBe(0);
      expect(alert!.auditTrail).toHaveLength(1);
      expect(alert!.auditTrail[0].action).toBe('TRIGGERED');

      // Verify notification sent via mandatory channel
      expect(notificationsService.createNotification).toHaveBeenCalled();
      expect(dispatchedNotifications[0].userId).toBe('admin');
      expect(dispatchedNotifications[0].type).toBe('RECOVERY_INTERRUPTED');
    });

    it('should trigger CRITICAL_DEFICIT when coverage is between 50% and 80%', async () => {
      const alert = await service.evaluateFunding(
        102,
        10_000_000n,
        7_000_000n, // 70% -> 7000 bps
      );

      expect(alert!.severity).toBe('CRITICAL_DEFICIT');
      expect(alert!.shortfall).toBe('3000000');
      expect(alert!.coverageBps).toBe(7000);
    });

    it('should trigger EMERGENCY_INSOLVENCY when coverage is at or below 50%', async () => {
      const alert = await service.evaluateFunding(
        103,
        10_000_000n,
        4_000_000n, // 40% -> 4000 bps
      );

      expect(alert!.severity).toBe('EMERGENCY_INSOLVENCY');
      expect(alert!.shortfall).toBe('6000000');
      expect(alert!.coverageBps).toBe(4000);
    });

    it('should auto-resolve active alert when reserves fully cover liabilities', async () => {
      // 1. Initial deficit
      const alert = await service.evaluateFunding(104, 5_000_000n, 3_000_000n);
      expect(alert!.status).toBe('ACTIVE');

      // 2. Replenishment brings reserves >= liabilities
      const resolved = await service.evaluateFunding(
        104,
        5_000_000n,
        5_500_000n,
        'Liquidity injection complete',
      );

      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe('RESOLVED');
      expect(resolved!.shortfall).toBe('0');
      expect(resolved!.coverageBps).toBe(10000);
      expect(resolved!.severity).toBe('ADEQUATE');
      expect(resolved!.resolvedAt).toBeDefined();

      // Verify active alert map cleared
      const active = await service.getActiveAlert(104);
      expect(active).toBeNull();
    });

    it('should aggregate liabilities and reserves from breakdown structures', async () => {
      const liabilitiesBreakdown = {
        principalLiability: 8_000_000n,
        couponLiability: 1_500_000n,
        penaltyLiability: 500_000n,
      };
      const reservesBreakdown = {
        escrowBalance: 6_000_000n,
        bufferBalance: 1_000_000n,
        insuranceBalance: 500_000n,
      };

      const alert = await service.evaluateFunding(105, liabilitiesBreakdown, reservesBreakdown);
      expect(alert).not.toBeNull();
      expect(alert!.totalLiabilities).toBe('10000000'); // 8M + 1.5M + 0.5M
      expect(alert!.availableReserves).toBe('7500000'); // 6M + 1M + 0.5M
      expect(alert!.shortfall).toBe('2500000');
      expect(alert!.coverageBps).toBe(7500);
      expect(alert!.severity).toBe('CRITICAL_DEFICIT');
    });
  });

  describe('Failure Path', () => {
    it('should reject negative liabilities with BadRequestException', async () => {
      await expect(
        service.evaluateFunding(106, -100n, 5_000_000n),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject negative reserves with BadRequestException', async () => {
      await expect(
        service.evaluateFunding(106, 5_000_000n, -500n),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject invalid threshold configurations in constructor', () => {
      expect(
        () =>
          new LiabilityReserveAlertService(undefined, undefined, {
            warningThresholdBps: 7000,
            criticalThresholdBps: 8000, // warning < critical -> invalid
          }),
      ).toThrow(BadRequestException);
    });

    it('should throw NotFoundException when acknowledging non-existent alert', async () => {
      await expect(
        service.acknowledgeAlert('non-existent-id', { actor: 'alice', role: 'admin' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when acknowledging an already acknowledged alert', async () => {
      const alert = await service.evaluateFunding(107, 10_000_000n, 7_000_000n);
      await service.acknowledgeAlert(alert!.alertId, { actor: 'alice', role: 'admin' });

      await expect(
        service.acknowledgeAlert(alert!.alertId, { actor: 'bob', role: 'admin' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when acknowledging an already resolved alert', async () => {
      const alert = await service.evaluateFunding(108, 10_000_000n, 7_000_000n);
      await service.resolveAlert(alert!.alertId, {
        actor: 'treasury',
        role: 'admin',
        replenishedAmount: 3_000_000n,
      });

      await expect(
        service.acknowledgeAlert(alert!.alertId, { actor: 'alice', role: 'admin' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when resolving with insufficient replenishment amount', async () => {
      const alert = await service.evaluateFunding(109, 10_000_000n, 7_000_000n);
      // shortfall is 3,000,000, attempt replenishment with only 1,000,000
      await expect(
        service.resolveAlert(alert!.alertId, {
          actor: 'treasury',
          role: 'admin',
          replenishedAmount: 1_000_000n,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when resolving an already resolved alert', async () => {
      const alert = await service.evaluateFunding(110, 10_000_000n, 7_000_000n);
      await service.resolveAlert(alert!.alertId, {
        actor: 'treasury',
        role: 'admin',
        replenishedAmount: 3_000_000n,
      });

      await expect(
        service.resolveAlert(alert!.alertId, {
          actor: 'treasury',
          role: 'admin',
          replenishedAmount: 3_000_000n,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Retry Path', () => {
    it('should idempotently update existing active alert on retry without duplicating alert ID', async () => {
      // First evaluation triggers alert
      const alert1 = await service.evaluateFunding(111, 10_000_000n, 8_500_000n);
      expect(alert1!.retryCount).toBe(0);
      const originalAlertId = alert1!.alertId;

      // Second evaluation with same severity (WARNING) retries existing alert
      const alert2 = await service.evaluateFunding(111, 10_000_000n, 8_600_000n);
      expect(alert2!.alertId).toBe(originalAlertId);
      expect(alert2!.retryCount).toBe(1);
      expect(alert2!.availableReserves).toBe('8600000');
      expect(alert2!.shortfall).toBe('1400000');
      expect(alert2!.auditTrail).toHaveLength(2);
      expect(alert2!.auditTrail[1].action).toBe('RETRIED');

      // Third evaluation
      const alert3 = await service.evaluateFunding(111, 10_000_000n, 8_400_000n);
      expect(alert3!.alertId).toBe(originalAlertId);
      expect(alert3!.retryCount).toBe(2);
      expect(alert3!.auditTrail).toHaveLength(3);
    });

    it('should escalate to a new alert when deficit severity worsens', async () => {
      // 1. Initial warning (85% coverage)
      const warningAlert = await service.evaluateFunding(112, 10_000_000n, 8_500_000n);
      expect(warningAlert!.severity).toBe('WARNING');

      // 2. Deficit worsens to Emergency Insolvency (45% coverage)
      const escalatedAlert = await service.evaluateFunding(112, 10_000_000n, 4_500_000n);
      expect(escalatedAlert!.severity).toBe('EMERGENCY_INSOLVENCY');
      expect(escalatedAlert!.alertId).not.toBe(warningAlert!.alertId);
      expect(escalatedAlert!.shortfall).toBe('5500000');

      // Verify old alert was resolved/superseded
      const oldAlert = await service.getAlert(warningAlert!.alertId);
      expect(oldAlert.status).toBe('RESOLVED');
      expect(oldAlert.auditTrail.some((e) => e.action === 'ESCALATED')).toBe(true);
    });
  });

  describe('Authorization Path', () => {
    it('should allow authorized roles to acknowledge alerts', async () => {
      const alert = await service.evaluateFunding(113, 10_000_000n, 7_000_000n);

      const acked = await service.acknowledgeAlert(alert!.alertId, {
        actor: 'risk-officer-01',
        role: 'risk_officer',
        note: 'Reviewing off-chain liquidity options',
      });

      expect(acked.status).toBe('ACKNOWLEDGED');
      expect(acked.acknowledgedBy).toBe('risk-officer-01');
      expect(acked.acknowledgedAt).toBeDefined();
      expect(acked.auditTrail[acked.auditTrail.length - 1].action).toBe('ACKNOWLEDGED');
    });

    it('should reject unauthorized roles attempting to acknowledge alerts', async () => {
      const alert = await service.evaluateFunding(114, 10_000_000n, 7_000_000n);

      await expect(
        service.acknowledgeAlert(alert!.alertId, {
          actor: 'unauthorized-user',
          role: 'investor',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow authorized roles to resolve alerts with full replenishment', async () => {
      const alert = await service.evaluateFunding(115, 10_000_000n, 7_000_000n);

      const resolved = await service.resolveAlert(alert!.alertId, {
        actor: 'treasury-admin',
        role: 'settlement_admin',
        replenishedAmount: 3_000_000n,
        note: 'Replenished from reserve vault',
      });

      expect(resolved.status).toBe('RESOLVED');
      expect(resolved.shortfall).toBe('0');
      expect(resolved.coverageBps).toBe(10000);
      expect(resolved.auditTrail[resolved.auditTrail.length - 1].action).toBe('RESOLVED');

      // Active alert is cleared
      expect(await service.getActiveAlert(115)).toBeNull();
    });

    it('should reject unauthorized roles attempting to resolve alerts', async () => {
      const alert = await service.evaluateFunding(116, 10_000_000n, 7_000_000n);

      await expect(
        service.resolveAlert(alert!.alertId, {
          actor: 'unauthorized-actor',
          role: 'auditor',
          replenishedAmount: 3_000_000n,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Financial Invariants', () => {
    it('preserves shortfall conservation: shortfall = max(0, liabilities - reserves)', async () => {
      const scenarios = [
        { liabilities: 100n, reserves: 120n, expectedShortfall: '0' },
        { liabilities: 100n, reserves: 100n, expectedShortfall: '0' },
        { liabilities: 100n, reserves: 80n, expectedShortfall: '20' },
        { liabilities: 100n, reserves: 0n, expectedShortfall: '100' },
      ];

      for (let i = 0; i < scenarios.length; i++) {
        const { liabilities, reserves, expectedShortfall } = scenarios[i];
        const alert = await service.evaluateFunding(200 + i, liabilities, reserves);
        if (expectedShortfall === '0') {
          expect(alert).toBeNull();
        } else {
          expect(alert!.shortfall).toBe(expectedShortfall);
        }
      }
    });

    it('preserves bounded coverage: 0 <= coverageBps <= 10000', async () => {
      const testCases = [
        { liabilities: 10_000n, reserves: 0n, expectedBps: 0 },
        { liabilities: 10_000n, reserves: 2_500n, expectedBps: 2500 },
        { liabilities: 10_000n, reserves: 9_999n, expectedBps: 9999 },
      ];

      for (let i = 0; i < testCases.length; i++) {
        const { liabilities, reserves, expectedBps } = testCases[i];
        const alert = await service.evaluateFunding(300 + i, liabilities, reserves);
        expect(alert!.coverageBps).toBe(expectedBps);
        expect(alert!.coverageBps).toBeGreaterThanOrEqual(0);
        expect(alert!.coverageBps).toBeLessThanOrEqual(10000);
      }
    });

    it('preserves monotonicity: shortfall monotonically decreases as reserves increase', async () => {
      const liabilities = 10_000_000n;
      let prevShortfall = 10_000_000n;

      for (let r = 0n; r <= 10_000_000n; r += 2_000_000n) {
        const alert = await service.evaluateFunding(400, liabilities, r);
        const currentShortfall = alert ? BigInt(alert.shortfall) : 0n;
        expect(currentShortfall).toBeLessThanOrEqual(prevShortfall);
        prevShortfall = currentShortfall;
      }
    });
  });
});
