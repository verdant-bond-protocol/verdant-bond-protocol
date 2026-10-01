import { Test, TestingModule } from '@nestjs/testing';
import { GracePeriodService, GracePeriodStatus } from './grace-period.service';
import { RedisService } from '../common/services/redis.service';

describe('GracePeriodService', () => {
  let service: GracePeriodService;
  let redis: RedisService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GracePeriodService,
        {
          provide: RedisService,
          useValue: {
            get: jest.fn(),
            setEx: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<GracePeriodService>(GracePeriodService);
    redis = module.get<RedisService>(RedisService);
  });

  describe('initiateGracePeriod', () => {
    it('should create grace period state', async () => {
      (redis.get as jest.Mock).mockResolvedValue(null);
      (redis.setEx as jest.Mock).mockResolvedValue('OK');

      const state = await service.initiateGracePeriod(1, 0, '75');

      expect(state.bondId).toBe(1);
      expect(state.couponPeriodIndex).toBe(0);
      expect(state.status).toBe(GracePeriodStatus.Active);
      expect(state.usedLastKnownGoodScore).toBe(true);
      expect(state.lastKnownGoodScore).toBe('75');
      expect(state.extensionCount).toBe(0);
    });
  });

  describe('extendGracePeriod', () => {
    it('should extend grace period', async () => {
      const mockState = {
        bondId: 1,
        couponPeriodIndex: 0,
        status: GracePeriodStatus.Active,
        gracePeriodStartedAt: Date.now(),
        extensionCount: 0,
        oracleDownSince: Date.now(),
        usedLastKnownGoodScore: true,
        lastKnownGoodScore: '75',
        conservatismDiscountApplied: 5,
        delayedPaymentEventEmitted: false,
      };

      (redis.get as jest.Mock)
        .mockResolvedValueOnce(JSON.stringify(mockState))
        .mockResolvedValueOnce(null);
      (redis.setEx as jest.Mock).mockResolvedValue('OK');

      const extended = await service.extendGracePeriod(1, 0);

      expect(extended.extensionCount).toBe(1);
      expect(extended.status).toBe(GracePeriodStatus.Extended);
    });

    it('should throw when max extensions exceeded', async () => {
      const mockState = {
        bondId: 1,
        couponPeriodIndex: 0,
        status: GracePeriodStatus.Extended,
        gracePeriodStartedAt: Date.now(),
        extensionCount: 3,
        oracleDownSince: Date.now(),
        usedLastKnownGoodScore: true,
        lastKnownGoodScore: '75',
        conservatismDiscountApplied: 5,
        delayedPaymentEventEmitted: false,
      };

      (redis.get as jest.Mock)
        .mockResolvedValueOnce(JSON.stringify(mockState))
        .mockResolvedValueOnce(JSON.stringify({ gracePeriodDurationSeconds: 3600, maxExtensions: 3 }));

      await expect(service.extendGracePeriod(1, 0)).rejects.toThrow(
        /limit.*exceeded/i,
      );
    });
  });

  describe('isGracePeriodActive', () => {
    it('should return true when grace period is active', async () => {
      const mockState = {
        bondId: 1,
        couponPeriodIndex: 0,
        status: GracePeriodStatus.Active,
        gracePeriodStartedAt: Date.now() - 1000,
        extensionCount: 0,
        oracleDownSince: Date.now(),
        usedLastKnownGoodScore: true,
        lastKnownGoodScore: '75',
        conservatismDiscountApplied: 5,
        delayedPaymentEventEmitted: false,
      };

      (redis.get as jest.Mock)
        .mockResolvedValueOnce(JSON.stringify(mockState))
        .mockResolvedValueOnce(null);

      const result = await service.isGracePeriodActive(1, 0);

      expect(result).toBe(true);
    });

    it('should return false when grace period expired', async () => {
      const mockState = {
        bondId: 1,
        couponPeriodIndex: 0,
        status: GracePeriodStatus.Expired,
        gracePeriodStartedAt: Date.now(),
        extensionCount: 0,
        oracleDownSince: Date.now(),
        usedLastKnownGoodScore: true,
        lastKnownGoodScore: '75',
        conservatismDiscountApplied: 5,
        delayedPaymentEventEmitted: false,
      };

      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(mockState));

      const result = await service.isGracePeriodActive(1, 0);

      expect(result).toBe(false);
    });
  });

  describe('expireGracePeriod', () => {
    it('should expire grace period and record event', async () => {
      const mockState = {
        bondId: 1,
        couponPeriodIndex: 0,
        status: GracePeriodStatus.Active,
        gracePeriodStartedAt: Date.now(),
        extensionCount: 1,
        oracleDownSince: Date.now(),
        usedLastKnownGoodScore: true,
        lastKnownGoodScore: '75',
        conservatismDiscountApplied: 5,
        delayedPaymentEventEmitted: false,
      };

      (redis.get as jest.Mock)
        .mockResolvedValueOnce(JSON.stringify(mockState))
        .mockResolvedValueOnce(null);
      (redis.setEx as jest.Mock).mockResolvedValue('OK');

      const result = await service.expireGracePeriod(1, 0);

      expect(result).toBe(true);
    });
  });

  describe('resolveGracePeriod', () => {
    it('should clear grace period state', async () => {
      (redis.del as jest.Mock).mockResolvedValue(1);

      await service.resolveGracePeriod(1, 0);

      expect(redis.del).toHaveBeenCalledWith('coupon:grace-state:1:0');
    });
  });

  describe('getConfig', () => {
    it('should return default config when not set', async () => {
      (redis.get as jest.Mock).mockResolvedValue(null);

      const config = await service.getConfig();

      expect(config.gracePeriodDurationSeconds).toBe(3600);
      expect(config.maxExtensions).toBe(3);
      expect(config.conservatismDiscountPercent).toBe(5);
    });

    it('should return custom config when set', async () => {
      const customConfig = {
        gracePeriodDurationSeconds: 7200,
        maxExtensions: 5,
        conservatismDiscountPercent: 10,
        lastKnownGoodPerformanceScoreAllowed: true,
      };

      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(customConfig));

      const config = await service.getConfig();

      expect(config).toEqual(customConfig);
    });
  });

  describe('setConfig', () => {
    it('should update grace period config', async () => {
      (redis.setEx as jest.Mock).mockResolvedValue('OK');

      await service.setConfig({ maxExtensions: 5 });

      expect(redis.setEx).toHaveBeenCalled();
      const call = (redis.setEx as jest.Mock).mock.calls[0];
      const configStr = call[2];
      const config = JSON.parse(configStr);
      expect(config.maxExtensions).toBe(5);
    });
  });

  describe('listDelayedPaymentEvents', () => {
    it('should return delayed payment events', async () => {
      const events = [
        {
          bondId: 1,
          couponPeriodIndex: 0,
          eventType: 'delayed_coupon_payment',
          status: GracePeriodStatus.Expired,
          extensionsUsed: 1,
        },
      ];

      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(events));

      const result = await service.listDelayedPaymentEvents();

      expect(result).toEqual(events);
    });

    it('should return empty array when no events', async () => {
      (redis.get as jest.Mock).mockResolvedValue(null);

      const result = await service.listDelayedPaymentEvents();

      expect(result).toEqual([]);
    });
  });
});
