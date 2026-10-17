export type DependencyState = 'operational' | 'degraded' | 'down' | 'unknown';

export interface DependencyHealth {
  name: string;
  state: DependencyState;
  message?: string;
  latencyMs?: number;
  lastCheckedAt?: string;
  critical?: boolean;
}

export interface HealthReport {
  status: 'healthy' | 'degraded' | 'down';
  timestamp: string;
  uptimeMs?: number;
  version?: string;
  dependencies: DependencyHealth[];
  details?: Record<string, unknown>;
}

export interface HealthIndicator {
  name: string;
  critical?: boolean;
  check(): Promise<DependencyHealth>;
}
