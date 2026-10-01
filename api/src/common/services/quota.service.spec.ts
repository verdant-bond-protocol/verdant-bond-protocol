import { Test, TestingModule } from '@nestjs/testing';
import { QuotaService, QuotaResource } from './quota.service';
import { RedisService } from './redis.service';
import { RbacService } from '../../auth/rbac.service';
import { Role } from '../../auth/rbac';
import { DomainException, ErrorCode } from '../errors/error-codes';

describe('QuotaService', () => {
  let service: QuotaService;
  let redisService: jest.Mocked<RedisService>;
  let rbacService: jest.Mocked<RbacService>;

  beforeEach(async () => {
    const redisMock = {
      get: jest.fn(),
      incrOrThrow: jest.fn(),
      expire: jest.fn(),
      ttl: jest.fn(),
    };
    
    const rbacMock = {
      getUserRoles: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuotaService,
        { provide: RedisService, useValue: redisMock },
        { provide: RbacService, useValue: rbacMock },
      ],
    }).compile();

    service = module.get<QuotaService>(QuotaService);
    redisService = module.get(RedisService);
    rbacService = module.get(RbacService);
  });

  it('allows usage within limits and expires correctly', async () => {
    rbacService.getUserRoles.mockReturnValue([Role.ISSUER]);
    redisService.get.mockResolvedValue('0');
    redisService.incrOrThrow.mockResolvedValue(1);

    await service.checkAndConsume('user1', QuotaResource.CREATE_BOND);

    expect(redisService.incrOrThrow).toHaveBeenCalledWith('quota:create_bond:user1');
    expect(redisService.expire).toHaveBeenCalledWith('quota:create_bond:user1', 86400);
  });

  it('blocks usage over the limit with DomainException', async () => {
    rbacService.getUserRoles.mockReturnValue([Role.ISSUER]);
    redisService.get.mockResolvedValue('10'); // Limit is 10 for CREATE_BOND
    redisService.ttl.mockResolvedValue(3600);

    await expect(service.checkAndConsume('user1', QuotaResource.CREATE_BOND)).rejects.toThrow(DomainException);
    await expect(service.checkAndConsume('user1', QuotaResource.CREATE_BOND)).rejects.toMatchObject({
      code: ErrorCode.QUOTA_EXCEEDED,
    });
  });

  it('bypasses quotas for maintainer role', async () => {
    rbacService.getUserRoles.mockReturnValue([Role.MAINTAINER]);
    
    await service.checkAndConsume('admin1', QuotaResource.CREATE_BOND);

    // Should not call redis at all
    expect(redisService.get).not.toHaveBeenCalled();
    expect(redisService.incrOrThrow).not.toHaveBeenCalled();
  });
});
