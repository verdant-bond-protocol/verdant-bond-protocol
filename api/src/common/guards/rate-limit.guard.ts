import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from '../services/redis.service';
import { RATE_LIMIT_METADATA_KEY, RateLimitOptions } from '../decorators/rate-limit.decorator';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redisService: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!options) {
      return true; // No rate limit set
    }

    // Fail-open strategy: if Redis is unhealthy or disabled, bypass rate limiting
    if (!this.redisService.isHealthy()) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const ip =
      request.ip ||
      request.headers['x-forwarded-for'] ||
      (request.connection && request.connection.remoteAddress) ||
      '127.0.0.1';

    // Extract wallet / provider / investor address
    let walletAddress = request.headers['x-wallet-address'] || (request.user && request.user.walletAddress);
    if (!walletAddress && request.body) {
      walletAddress =
        request.body.address ||
        request.body.sellerAddress ||
        request.body.buyerAddress ||
        request.body.investorAddress ||
        request.body.fromAddress ||
        request.body.toAddress;
    }

    let providerAddress = request.headers['x-provider-address'];
    if (!providerAddress && request.body) {
      providerAddress = request.body.providerAddress;
    }

    const type = options.type;
    let ttl = options.ttl;
    let limit = options.limit;

    // Load defaults from environment variables if not specified in options
    if (!ttl || !limit) {
      if (type === 'auth') {
        ttl = parseInt(process.env.RATE_LIMIT_AUTH_TTL || '60', 10);
        limit = parseInt(process.env.RATE_LIMIT_AUTH_LIMIT || '5', 10);
      } else if (type === 'mutation') {
        ttl = parseInt(process.env.RATE_LIMIT_MUTATION_TTL || '60', 10);
        limit = parseInt(process.env.RATE_LIMIT_MUTATION_LIMIT || '10', 10);
      } else if (type === 'oracle') {
        ttl = parseInt(process.env.RATE_LIMIT_ORACLE_TTL || '60', 10);
        limit = parseInt(process.env.RATE_LIMIT_ORACLE_LIMIT || '10', 10);
      } else {
        ttl = parseInt(process.env.RATE_LIMIT_DEFAULT_TTL || '60', 10);
        limit = parseInt(process.env.RATE_LIMIT_DEFAULT_LIMIT || '60', 10);
      }
    }

    const keysToCheck: string[] = [];

    if (type === 'auth') {
      keysToCheck.push(`ratelimit:auth:ip:${ip}`);
      if (walletAddress) {
        keysToCheck.push(`ratelimit:auth:wallet:${walletAddress}`);
      }
    } else if (type === 'oracle') {
      if (providerAddress) {
        keysToCheck.push(`ratelimit:oracle:provider:${providerAddress}`);
      } else if (walletAddress) {
        keysToCheck.push(`ratelimit:oracle:provider:${walletAddress}`);
      }
      keysToCheck.push(`ratelimit:oracle:ip:${ip}`);
    } else if (type === 'mutation') {
      if (walletAddress) {
        keysToCheck.push(`ratelimit:mutation:wallet:${walletAddress}`);
      }
      keysToCheck.push(`ratelimit:mutation:ip:${ip}`);
    } else {
      keysToCheck.push(`ratelimit:default:ip:${ip}`);
    }

    // Check rate limits first
    for (const key of keysToCheck) {
      const current = await this.redisService.get(key);
      const count = current ? parseInt(current, 10) : 0;

      if (count >= limit) {
        const timeRemaining = await this.redisService.ttl(key);
        const retryAfter = timeRemaining > 0 ? timeRemaining : ttl;
        response.header('Retry-After', String(retryAfter));
        throw new HttpException(
          {
            message: 'Too Many Requests',
            code: 'RATE_LIMIT_EXCEEDED',
            detail: `Rate limit exceeded. Please try again in ${retryAfter} seconds.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    // Increment all keys
    for (const key of keysToCheck) {
      const count = await this.redisService.incrOrThrow(key);
      if (count === 1) {
        await this.redisService.expire(key, ttl);
      }
    }

    return true;
  }
}
