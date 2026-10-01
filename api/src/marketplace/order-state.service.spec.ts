import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { OrderStateService, VersionedOrderState } from './order-state.service';
import { OrderStatus } from './interfaces/marketplace.interface';
import { RedisService } from '../common/services/redis.service';

describe('OrderStateService', () => {
  let service: OrderStateService;
  let redis: RedisService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderStateService,
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

    service = module.get<OrderStateService>(OrderStateService);
    redis = module.get<RedisService>(RedisService);
  });

  describe('getOrderState', () => {
    it('should return existing order state', async () => {
      const mockState: VersionedOrderState = {
        orderId: 1,
        version: 5,
        status: OrderStatus.PartiallyFilled,
        filledAmount: '50',
        lastModified: Date.now(),
      };

      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(mockState));

      const result = await service.getOrderState(1);
      expect(result).toEqual(mockState);
    });

    it('should initialize new order state', async () => {
      (redis.get as jest.Mock).mockResolvedValue(null);
      (redis.setEx as jest.Mock).mockResolvedValue('OK');

      const result = await service.getOrderState(2);

      expect(result.orderId).toBe(2);
      expect(result.version).toBe(0);
      expect(result.status).toBe(OrderStatus.Open);
      expect(result.filledAmount).toBe('0');
    });
  });

  describe('transitionState', () => {
    it('should successfully transition state with matching version', async () => {
      const existing: VersionedOrderState = {
        orderId: 1,
        version: 0,
        status: OrderStatus.Open,
        filledAmount: '0',
        lastModified: Date.now(),
      };

      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(existing));
      (redis.setEx as jest.Mock).mockResolvedValue('OK');

      const result = await service.transitionState(1, 0, OrderStatus.PartiallyFilled, '25');

      expect(result.version).toBe(1);
      expect(result.status).toBe(OrderStatus.PartiallyFilled);
      expect(result.filledAmount).toBe('25');
    });

    it('should throw ConflictException on version mismatch', async () => {
      const existing: VersionedOrderState = {
        orderId: 1,
        version: 2,
        status: OrderStatus.Filled,
        filledAmount: '100',
        lastModified: Date.now(),
      };

      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(existing));

      await expect(service.transitionState(1, 0, OrderStatus.Cancelled)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('rollbackAfterSettlementFailure', () => {
    it('should revert order to Open status after settlement failure', async () => {
      const current: VersionedOrderState = {
        orderId: 1,
        version: 3,
        status: OrderStatus.PartiallyFilled,
        filledAmount: '50',
        lastModified: Date.now(),
      };

      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(current));
      (redis.setEx as jest.Mock).mockResolvedValue('OK');

      const result = await service.rollbackAfterSettlementFailure(1);

      expect(result.version).toBe(4);
      expect(result.status).toBe(OrderStatus.Open);
      expect(result.filledAmount).toBe('0');
    });
  });

  describe('markSettled', () => {
    it('should mark order as Filled', async () => {
      const current: VersionedOrderState = {
        orderId: 1,
        version: 2,
        status: OrderStatus.PartiallyFilled,
        filledAmount: '100',
        lastModified: Date.now(),
      };

      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(current));
      (redis.setEx as jest.Mock).mockResolvedValue('OK');

      const result = await service.markSettled(1);

      expect(result.version).toBe(3);
      expect(result.status).toBe(OrderStatus.Filled);
    });
  });

  describe('clearOnCancellation', () => {
    it('should delete order state', async () => {
      (redis.del as jest.Mock).mockResolvedValue(1);

      await service.clearOnCancellation(1);

      expect(redis.del).toHaveBeenCalledWith('order:state:1');
    });
  });
});
