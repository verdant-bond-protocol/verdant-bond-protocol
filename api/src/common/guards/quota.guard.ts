import {
  Injectable,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { QuotaService, QuotaResource } from '../services/quota.service';
import { QUOTA_METADATA_KEY } from '../decorators/quota.decorator';

@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly quotaService: QuotaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const resource = this.reflector.getAllAndOverride<QuotaResource>(
      QUOTA_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!resource) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    
    // Determine actor ID (wallet address)
    let actorId = request.headers['x-wallet-address'] || (request.user && request.user.walletAddress);
    if (!actorId && request.headers['x-provider-address']) {
      actorId = request.headers['x-provider-address'];
    }
    
    if (!actorId) {
      // If we can't identify the actor, we fallback to IP or just deny?
      // Since quota is per actor, it should be authenticated or at least have a header
      actorId = request.ip || 'anonymous';
    }

    await this.quotaService.checkAndConsume(actorId, resource);
    return true;
  }
}
