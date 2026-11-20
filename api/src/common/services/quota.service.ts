import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';
import { ErrorCode, DomainException } from '../errors/error-codes';
import { RbacService } from '../../auth/rbac.service';
import { Role } from '../../auth/rbac';

export enum QuotaResource {
  CREATE_BOND = 'create_bond',
  SUBMIT_ORACLE_REPORT = 'submit_oracle_report',
  RECONCILE_HOLDERS = 'reconcile_holders',
}

const QUOTA_LIMITS: Record<QuotaResource, number> = {
  [QuotaResource.CREATE_BOND]: 10, // Max 10 bonds per day per issuer
  [QuotaResource.SUBMIT_ORACLE_REPORT]: 100, // Max 100 reports per day per provider
  [QuotaResource.RECONCILE_HOLDERS]: 5, // Max 5 reconciliations per day per manager
};

const QUOTA_RESET_SECONDS = 86400; // Daily reset

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly rbacService: RbacService,
  ) {}

  async checkAndConsume(actorId: string, resource: QuotaResource): Promise<void> {
    const roles = this.rbacService.getUserRoles(actorId);
    if (roles.includes(Role.MAINTAINER)) {
      // Maintainers bypass quotas
      return;
    }

    const key = `quota:${resource}:${actorId}`;
    const usage = await this.redis.get(key);
    const count = usage ? parseInt(usage, 10) : 0;

    const limit = QUOTA_LIMITS[resource];
    if (count >= limit) {
      throw new DomainException(ErrorCode.QUOTA_EXCEEDED, {
        resource,
        limit,
        resetInSeconds: await this.redis.ttl(key),
      });
    }

    const newCount = await this.redis.incrOrThrow(key);
    if (newCount === 1) {
      await this.redis.expire(key, QUOTA_RESET_SECONDS);
    }
  }

  async getUsage(actorId: string, resource: QuotaResource): Promise<{ count: number; limit: number; ttl: number }> {
    const key = `quota:${resource}:${actorId}`;
    const usage = await this.redis.get(key);
    const ttl = await this.redis.ttl(key);
    return {
      count: usage ? parseInt(usage, 10) : 0,
      limit: QUOTA_LIMITS[resource],
      ttl: ttl > 0 ? ttl : 0,
    };
  }

  async getAllUsageForActor(actorId: string): Promise<Record<string, any>> {
    const results: Record<string, any> = {};
    for (const resource of Object.values(QuotaResource)) {
      results[resource] = await this.getUsage(actorId, resource);
    }
    return results;
  }
}
