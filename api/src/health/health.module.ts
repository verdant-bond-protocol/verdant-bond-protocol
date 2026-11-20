import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';
import { VersionHealthIndicator } from './indicators/version.health-indicator';

@Module({
  controllers: [HealthController],
  providers: [HealthService, RedisHealthIndicator, VersionHealthIndicator],
  exports: [HealthService],
})
export class HealthModule {}
