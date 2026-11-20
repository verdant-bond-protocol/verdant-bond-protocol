import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HealthIndicator, HealthReport, DependencyHealth } from './health.interface';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';
import { VersionHealthIndicator } from './indicators/version.health-indicator';

@Injectable()
export class HealthService implements OnModuleInit {
  private readonly logger = new Logger(HealthService.name);
  private readonly indicators: HealthIndicator[] = [];
  private readonly startTime = Date.now();

  constructor(
    private readonly redisIndicator: RedisHealthIndicator,
    private readonly versionIndicator: VersionHealthIndicator,
  ) {}

  onModuleInit(): void {
    this.registerIndicator(this.redisIndicator, true);
    this.registerIndicator(this.versionIndicator, false);
  }

  registerIndicator(indicator: HealthIndicator, critical = false): void {
    this.indicators.push({
      name: indicator.name,
      critical: critical || indicator.critical === true,
      check: () => indicator.check(),
    });
  }

  async getReport(): Promise<HealthReport> {
    const checks = this.indicators.map(async (indicator) => {
      const start = Date.now();
      try {
        const health = await indicator.check();
        return {
          ...health,
          name: indicator.name,
          critical: indicator.critical,
          latencyMs: health.latencyMs ?? Date.now() - start,
        } as DependencyHealth;
      } catch (error) {
        this.logger.warn(
          `Health indicator ${indicator.name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return {
          name: indicator.name,
          state: 'down',
          message: error instanceof Error ? error.message : 'Unknown error',
          latencyMs: Date.now() - start,
          critical: indicator.critical,
        } as DependencyHealth;
      }
    });

    const dependencies = await Promise.all(checks);

    const hasDownCritical = dependencies.some((d) => d.critical === true && d.state === 'down');
    const hasImpaired = dependencies.some((d) => d.state !== 'operational');

    let status: HealthReport['status'] = 'healthy';
    if (hasDownCritical) {
      status = 'down';
    } else if (hasImpaired) {
      status = 'degraded';
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      uptimeMs: Date.now() - this.startTime,
      dependencies,
    };
  }
}
