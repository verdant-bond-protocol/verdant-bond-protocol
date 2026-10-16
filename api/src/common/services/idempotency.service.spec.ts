import { IdempotencyService } from './idempotency.service';
import { RedisService } from './redis.service';

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  let redis: any;

  beforeEach(() => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      setNxValue: jest.fn().mockResolvedValue(true),
      setEx: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    service = new IdempotencyService(redis as unknown as RedisService);
  });

  it('produces a stable fingerprint for identical requests and differs otherwise', () => {
    const a = IdempotencyService.fingerprintOf('POST', '/bonds/1/subscribe', { amount: 10 });
    const b = IdempotencyService.fingerprintOf('POST', '/bonds/1/subscribe', { amount: 10 });
    const c = IdempotencyService.fingerprintOf('POST', '/bonds/1/subscribe', { amount: 20 });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('completes and persists a record', async () => {
    await service.complete('k1', 'success', { transactionHash: '0xabc' });
    expect(redis.setEx).toHaveBeenCalled();
    const stored = JSON.parse(redis.setEx.mock.calls[0][2]);
    expect(stored.status).toBe('success');
    expect(stored.transactionHash).toBe('0xabc');
  });

  it('reads back a pending record', async () => {
    redis.get.mockResolvedValue(JSON.stringify({ status: 'pending', fingerprint: 'f', createdAt: 1 }));
    const rec = await service.get('k');
    expect(rec?.status).toBe('pending');
  });

  it('markPending returns false when a record already exists', async () => {
    redis.setNxValue.mockResolvedValue(false);
    expect(await service.markPending('k', 'f')).toBe(false);
  });
});
