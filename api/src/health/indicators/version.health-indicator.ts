import { Injectable } from '@nestjs/common';
import { DependencyHealth, HealthIndicator } from '../health.interface';

@Injectable()
export class VersionHealthIndicator implements HealthIndicator {
  name = 'version';
  critical = false;

  async check(): Promise<DependencyHealth> {
    return {
      name: this.name,
      state: 'operational',
      message: `API version ${process.env.npm_package_version || '0.1.0'}`,
      latencyMs: 0,
      lastCheckedAt: new Date().toISOString(),
      critical: this.critical,
    };
  }
}
