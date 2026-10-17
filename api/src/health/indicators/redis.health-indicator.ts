import { Injectable } from '@nestjs/common';
import { RedisService } from '../../common/services/redis.service';
import { DependencyHealth, HealthIndicator } from '../health.interface';

@Injectable()
export class RedisHealthIndicator implements HealthIndicator {
  name = 'redis';
  critical = true;

  constructor(private readonly redis: RedisService) {}

  async check(): Promise<DependencyHealth> {
    const start = Date.now();
    const healthy = this.redis.isHealthy();
    return {
      name: this.name,
      state: healthy ? 'operational' : 'down',
      message: healthy ? 'Redis is healthy' : 'Redis is unavailable',
      latencyMs: Date.now() - start,
      lastCheckedAt: new Date().toISOString(),
      critical: this.critical,
    };
  }
}
