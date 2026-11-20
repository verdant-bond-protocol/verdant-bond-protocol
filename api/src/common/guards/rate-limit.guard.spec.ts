import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { RateLimitGuard } from './rate-limit.guard';
import { RedisService } from '../services/redis.service';
import { RATE_LIMIT_METADATA_KEY } from '../decorators/rate-limit.decorator';

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let reflector: Reflector;
  let redisService: jest.Mocked<RedisService>;

  const mockRedisService = {
    isHealthy: jest.fn(),
    get: jest.fn(),
    incrOrThrow: jest.fn(),
    expire: jest.fn(),
    ttl: jest.fn(),
  };

  const mockReflector = {
    getAllAndOverride: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        { provide: Reflector, useValue: mockReflector },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    guard = module.get<RateLimitGuard>(RateLimitGuard);
    reflector = module.get<Reflector>(Reflector);
    redisService = module.get(RedisService);
    
    // Reset all mocks
    jest.resetAllMocks();
  });

  const createMockContext = (ip: string, wallet?: string, body?: any): ExecutionContext => {
    const req = {
      ip,
      headers: wallet ? { 'x-wallet-address': wallet } : {},
      body: body || {},
    };
    const res = {
      header: jest.fn(),
    };
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  };

  it('should allow requests if no rate limit metadata is present', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(undefined);

    const context = createMockContext('127.0.0.1');
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(mockRedisService.isHealthy).not.toHaveBeenCalled();
  });

  it('should allow requests if Redis is unhealthy (fail-open)', async () => {
    mockReflector.getAllAndOverride.mockReturnValue({ type: 'auth' });
    mockRedisService.isHealthy.mockReturnValue(false);

    const context = createMockContext('127.0.0.1');
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(mockRedisService.isHealthy).toHaveBeenCalled();
    expect(mockRedisService.get).not.toHaveBeenCalled();
  });

  it('should allow requests below the limit and increment keys', async () => {
    mockReflector.getAllAndOverride.mockReturnValue({ type: 'auth', limit: 2, ttl: 60 });
    mockRedisService.isHealthy.mockReturnValue(true);
    mockRedisService.get.mockResolvedValue(null);
    mockRedisService.incrOrThrow.mockResolvedValue(1);

    const context = createMockContext('192.168.1.1');
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(mockRedisService.get).toHaveBeenCalledWith('ratelimit:auth:ip:192.168.1.1');
    expect(mockRedisService.incrOrThrow).toHaveBeenCalledWith('ratelimit:auth:ip:192.168.1.1');
    expect(mockRedisService.expire).toHaveBeenCalledWith('ratelimit:auth:ip:192.168.1.1', 60);
  });

  it('should block requests exceeding the limit and set Retry-After header', async () => {
    mockReflector.getAllAndOverride.mockReturnValue({ type: 'auth', limit: 1, ttl: 60 });
    mockRedisService.isHealthy.mockReturnValue(true);
    mockRedisService.get.mockResolvedValue('1');
    mockRedisService.ttl.mockResolvedValue(45);

    const context = createMockContext('192.168.1.1');
    const res = context.switchToHttp().getResponse();

    await expect(guard.canActivate(context)).rejects.toThrow(
      new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS),
    );

    expect(res.header).toHaveBeenCalledWith('Retry-After', '45');
    expect(mockRedisService.incrOrThrow).not.toHaveBeenCalled();
  });

  it('should be wallet-aware and block based on wallet address', async () => {
    mockReflector.getAllAndOverride.mockReturnValue({ type: 'mutation', limit: 2, ttl: 60 });
    mockRedisService.isHealthy.mockReturnValue(true);
    // IP is below limit, but wallet key is at/above limit
    mockRedisService.get.mockImplementation(async (key: string) => {
      if (key.includes('wallet')) return '2';
      return '0';
    });
    mockRedisService.ttl.mockResolvedValue(30);

    const context = createMockContext('192.168.1.1', 'G_WALLET_123');
    const res = context.switchToHttp().getResponse();

    await expect(guard.canActivate(context)).rejects.toThrow(
      new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS),
    );

    expect(res.header).toHaveBeenCalledWith('Retry-After', '30');
    expect(mockRedisService.get).toHaveBeenCalledWith('ratelimit:mutation:wallet:G_WALLET_123');
  });
});
