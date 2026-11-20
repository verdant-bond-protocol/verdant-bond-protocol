import { ServiceUnavailableException } from '@nestjs/common';
import { NonceService } from './nonce.service';
import { RedisService } from './redis.service';

describe('NonceService', () => {
  it('allocates contract-scoped nonces atomically through Redis', async () => {
    const redis = {
      getOrThrow: jest.fn().mockResolvedValue('2'),
      acquireLockOrThrow: jest.fn().mockResolvedValue(true),
      releaseLockOrThrow: jest.fn().mockResolvedValue(undefined),
      setOrThrow: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisService;
    const contract = { simulateCall: jest.fn() } as any;
    const service = new NonceService(redis);

    await expect(service.withNonce('CDEX', 'GUSER', async () => 2, async (nonce: number) => nonce)).resolves.toBe(2);
    expect(redis.setOrThrow).toHaveBeenCalledWith('nonce:CDEX:GUSER', '3');
  });

  it('fails closed when Redis cannot allocate a nonce', async () => {
    const redis = {
      incrOrThrow: jest.fn().mockRejectedValue(new ServiceUnavailableException()),
      getOrThrow: jest.fn().mockRejectedValue(new ServiceUnavailableException()),
      acquireLockOrThrow: jest.fn().mockResolvedValue(true),
      releaseLockOrThrow: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisService;
    const service = new NonceService(redis);

    await expect(service.withNonce('CDEX', 'GUSER', async () => 0, async () => 1)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not advance the cursor when the operation fails', async () => {
    const redis = {
      getOrThrow: jest.fn().mockResolvedValue('4'),
      acquireLockOrThrow: jest.fn().mockResolvedValue(true),
      releaseLockOrThrow: jest.fn().mockResolvedValue(undefined),
      setOrThrow: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisService;
    const service = new NonceService(redis);

    await expect(service.withNonce('CDEX', 'GUSER', async () => 0, async () => {
      throw new Error('simulation failed');
    })).rejects.toThrow('simulation failed');
    expect(redis.setOrThrow).toHaveBeenCalledWith('nonce:CDEX:GUSER', '0');
  });

  it('serializes concurrent reservations for the same contract and address', async () => {
    let cursor = '0';
    const redis = {
      getOrThrow: jest.fn().mockImplementation(async () => cursor),
      acquireLockOrThrow: jest.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      releaseLockOrThrow: jest.fn().mockResolvedValue(undefined),
      setOrThrow: jest.fn().mockImplementation(async (_key, value) => {
        cursor = value;
      }),
    } as unknown as RedisService;
    const service = new NonceService(redis);

    const first = service.withNonce('CDEX', 'GUSER', async () => Number(cursor), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 1;
    });
    const second = service.withNonce('CDEX', 'GUSER', async () => Number(cursor), async (nonce: number) => nonce);

    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(redis.acquireLockOrThrow).toHaveBeenCalledTimes(3);
  });
});
