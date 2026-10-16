import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { OrderStateService, VersionedOrderState } from './order-state.service';
import { OrderStatus } from './interfaces/marketplace.interface';
import { RedisService } from '../common/services/redis.service';
import { EventLedgerService } from '../ledger/event-ledger.service';
import { InMemoryLedgerStore } from '../ledger/ledger.store';

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

describe('OrderStateService ledger coverage', () => {
  const state = (version: number, status: OrderStatus, filledAmount: string): VersionedOrderState => ({
    orderId: 7,
    version,
    status,
    filledAmount,
    lastModified: Date.now(),
  });

  it('records settlement completion and rollback as financial ledger events', async () => {
    const redis = { get: jest.fn(), setEx: jest.fn().mockResolvedValue('OK'), del: jest.fn() } as any;
    const ledger = new EventLedgerService(new InMemoryLedgerStore());
    const service = new OrderStateService(redis, ledger);

    redis.get.mockResolvedValue(JSON.stringify(state(2, OrderStatus.PartiallyFilled, '40')));
    await service.rollbackAfterSettlementFailure(7);
    redis.get.mockResolvedValue(JSON.stringify(state(3, OrderStatus.PartiallyFilled, '100')));
    await service.markSettled(7);

    const events = await ledger.query({ subjectType: 'marketplace-order', subjectId: '7' });
    expect(events.map((e) => [e.type, e.category])).toEqual([
      ['settlement.rolled_back', 'financial'],
      ['settlement.completed', 'financial'],
    ]);
    expect(events[0].payload).toMatchObject({ revertedFilledAmount: '40', toVersion: 3 });
    expect(events[1].payload).toMatchObject({ filledAmount: '100', version: 4 });
    expect((await ledger.verify()).ok).toBe(true);
  });

  it('does not ledger a settlement whose state transition failed', async () => {
    const redis = { get: jest.fn(), setEx: jest.fn().mockRejectedValue(new Error('redis down')), del: jest.fn() } as any;
    const ledger = new EventLedgerService(new InMemoryLedgerStore());
    const service = new OrderStateService(redis, ledger);
    redis.get.mockResolvedValue(JSON.stringify(state(1, OrderStatus.Open, '0')));

    await expect(service.markSettled(7)).rejects.toThrow('redis down');
    expect(await ledger.query()).toHaveLength(0);
  });
});
