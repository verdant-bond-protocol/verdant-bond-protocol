import { Test, TestingModule } from '@nestjs/testing';
import { TimelineService } from './timeline.service';
import { RedisService } from '../common/services/redis.service';
import { TimelineEventType } from './timeline.interface';

describe('TimelineService', () => {
  let service: TimelineService;
  let redisService: RedisService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimelineService,
        {
          provide: RedisService,
          useValue: {
            setEx: jest.fn().mockResolvedValue(undefined),
            lpush: jest.fn().mockResolvedValue(1),
            expire: jest.fn().mockResolvedValue(1),
            lrange: jest.fn().mockResolvedValue([]),
            get: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<TimelineService>(TimelineService);
    redisService = module.get<RedisService>(RedisService);
  });

  describe('recordEvent', () => {
    it('should record a public event', async () => {
      const event = {
        eventType: TimelineEventType.BOND_SUBSCRIBED,
        timestamp: Math.floor(Date.now() / 1000),
        actor: 'test-actor',
        bondId: 1,
        amount: '1000',
        isPublic: true,
      };

      const result = await service.recordEvent(event);

      expect(result).toMatchObject(event);
      expect(result.id).toBeDefined();
      expect(redisService.setEx).toHaveBeenCalled();
      expect(redisService.lpush).toHaveBeenCalled();
    });

    it('should record a private audit event', async () => {
      const event = {
        eventType: TimelineEventType.COUPON_CLAIMED,
        timestamp: Math.floor(Date.now() / 1000),
        actor: 'audit-admin',
        bondId: 2,
        isPublic: false,
        metadata: { auditReason: 'verification' },
      };

      const result = await service.recordEvent(event);

      expect(result).toMatchObject(event);
      expect(result.isPublic).toBe(false);
    });
  });

  describe('recordSubscription', () => {
    it('should record subscription event', async () => {
      const result = await service.recordSubscription(1, 'investor-address', '50000');

      expect(result).toMatchObject({
        eventType: TimelineEventType.BOND_SUBSCRIBED,
        bondId: 1,
        actor: 'investor-address',
        amount: '50000',
        isPublic: true,
      });
    });
  });

  describe('recordCouponClaim', () => {
    it('should record coupon claim event', async () => {
      const result = await service.recordCouponClaim(1, 'investor-address', '12500');

      expect(result).toMatchObject({
        eventType: TimelineEventType.COUPON_CLAIMED,
        bondId: 1,
        actor: 'investor-address',
        amount: '12500',
        isPublic: true,
      });
    });
  });

  describe('recordCouponDistribution', () => {
    it('should record coupon distribution event', async () => {
      const result = await service.recordCouponDistribution(1, '625000', 50);

      expect(result).toMatchObject({
        eventType: TimelineEventType.COUPON_DISTRIBUTED,
        bondId: 1,
        amount: '625000',
        isPublic: true,
        metadata: expect.objectContaining({ holderCount: 50 }),
      });
    });
  });

  describe('recordBondTransfer', () => {
    it('should record bond transfer event', async () => {
      const result = await service.recordBondTransfer(1, 'from-address', 'to-address', '25000');

      expect(result).toMatchObject({
        eventType: TimelineEventType.BOND_TRANSFERRED,
        bondId: 1,
        actor: 'from-address',
        amount: '25000',
        isPublic: true,
        metadata: expect.objectContaining({ to: 'to-address' }),
      });
    });
  });

  describe('getTimelineForAddress', () => {
    it('should return empty timeline when no events exist', async () => {
      const result = await service.getTimelineForAddress('test-address');

      expect(result.events).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should respect pagination parameters', async () => {
      const result = await service.getTimelineForAddress('test-address', {
        skip: 10,
        limit: 25,
      });

      expect(result.skip).toBe(10);
      expect(result.limit).toBe(25);
    });
  });

  describe('getTimelineForBond', () => {
    it('should return empty timeline when no events exist', async () => {
      const result = await service.getTimelineForBond(1);

      expect(result.events).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should filter by event types', async () => {
      const result = await service.getTimelineForBond(1, {
        eventTypes: [TimelineEventType.COUPON_CLAIMED],
      });

      expect(result).toBeDefined();
    });
  });

  describe('recordAuditEvent', () => {
    it('should record private audit event', async () => {
      const result = await service.recordAuditEvent(
        TimelineEventType.COUPON_CLAIMED,
        'auditor',
        1,
        { reason: 'compliance_check' },
      );

      expect(result).toMatchObject({
        eventType: TimelineEventType.COUPON_CLAIMED,
        actor: 'auditor',
        bondId: 1,
        isPublic: false,
        metadata: { reason: 'compliance_check' },
      });
    });
  });
});
