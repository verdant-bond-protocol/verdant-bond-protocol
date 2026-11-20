export interface HealthIndicator {
  status: 'healthy' | 'degraded' | 'unhealthy';
  description: string;
}

export interface StaleRecord {
  type: string;
  id: string;
  lastUpdated: string | null;
  link?: string;
}

export interface UnresolvedException {
  id: string;
  source: string;
  severity: string;
  message: string;
  link: string;
}

export interface OpsDashboardResponse {
  indicators: {
    oracle: HealthIndicator;
    marketplace: HealthIndicator;
    bonds: HealthIndicator;
  };
  unresolvedExceptions: UnresolvedException[];
  staleRecords: StaleRecord[];
}
