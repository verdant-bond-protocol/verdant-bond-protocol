# Observability & Telemetry

This document describes the observability infrastructure for monitoring system health, performance, and user behavior.

## Overview

The observability layer provides:
- Structured telemetry logging for all critical operations
- Correlation ID tracking for request tracing
- Operation-level metrics (latency, success/failure rate)
- Actor type classification (user, service, admin, system)
- Sensitive data redaction in logs

## Telemetry Fields

All telemetry events include:

```typescript
interface TelemetryFields {
  operation: string;           // Operation name (e.g., "bond_purchase", "coupon_distribution")
  actorType: 'user' | 'service' | 'system' | 'admin';
  result: 'success' | 'failure' | 'partial';
  durationMs: number;          // Execution time in milliseconds
  correlationId: string;       // Request tracing ID
  userId?: string;             // User performing operation (if applicable)
  businessMetric?: Record<string, number | string>; // Domain-specific metrics
  error?: string;              // Error message (if failed)
  errorCode?: string;          // Error code or HTTP status (if failed)
}
```

## Instrumentation Points

### HTTP Requests/Responses (Automatic)
All HTTP endpoints are automatically instrumented:

```json
{
  "operation": "GET /api/v1/bonds",
  "actorType": "user",
  "result": "success",
  "durationMs": 145,
  "correlationId": "req-12345"
}
```

### Custom Operations (Decorator)
Use the `@Telemetry()` decorator for service methods:

```typescript
import { Telemetry } from '@/common/decorators/telemetry.decorator';

export class BondService {
  @Telemetry('bond_creation', { actorType: 'user' })
  async createBond(data: BondInput): Promise<Bond> {
    // Automatically tracked
  }
}
```

### Manual Instrumentation (Service)
For fine-grained control:

```typescript
import { TelemetryService } from '@/common/services/telemetry.service';

export class MyService {
  constructor(private telemetry: TelemetryService) {}

  async processTransaction(id: string) {
    const start = Date.now();
    try {
      const result = await this.doWork(id);
      this.telemetry.emit({
        operation: 'transaction_process',
        actorType: 'system',
        result: 'success',
        durationMs: Date.now() - start,
        correlationId: this.correlationId,
        businessMetric: { transactionId: id, amount: result.amount },
      });
      return result;
    } catch (error) {
      this.telemetry.emit({
        operation: 'transaction_process',
        actorType: 'system',
        result: 'failure',
        durationMs: Date.now() - start,
        correlationId: this.correlationId,
        error: error.message,
        errorCode: error.code,
      });
      throw error;
    }
  }
}
```

## Correlation IDs

Correlation IDs enable request tracing across distributed systems:

### Request Headers
```
GET /api/v1/bonds HTTP/1.1
x-correlation-id: req-abc123-def456
```

Or use the auto-generated one:
```
x-request-id: <will be used if x-correlation-id not provided>
```

### Response Headers
```
HTTP/1.1 200 OK
x-correlation-id: req-abc123-def456
```

### In Logs
All events with the same correlationId belong to one logical request.

## Critical Operations Tracked

The following operations are monitored for latency, failure rate, and business health:

### Authentication & Authorization
- `auth_login` - User login
- `auth_token_refresh` - Token refresh
- `auth_kyc_check` - KYC validation

### Bond Lifecycle
- `bond_creation` - New bond creation
- `bond_purchase` - Investor purchase
- `bond_redemption` - Redemption request
- `tranche_creation` - Create bond tranche

### Coupon Distribution
- `coupon_calculation` - Calculate coupon amount
- `coupon_distribution` - Distribute coupons
- `coupon_payment` - Process payment

### Secondary Market
- `order_placement` - Create marketplace order
- `order_execution` - Execute order
- `order_cancellation` - Cancel order

### Data & Export
- `data_export_request` - Initiate data export
- `data_export_job` - Background export job
- `reconciliation_job` - Run reconciliation

### Oracle & Measurements
- `oracle_data_fetch` - Fetch oracle data
- `measurement_validation` - Validate measurement
- `performance_calculation` - Calculate project performance

## Dashboard Query Examples

### Request Latency by Endpoint
```
SELECT
  operation,
  AVG(durationMs) as avg_latency_ms,
  MAX(durationMs) as max_latency_ms,
  COUNT(*) as request_count
FROM telemetry
WHERE event='telemetry' AND result='success'
GROUP BY operation
ORDER BY avg_latency_ms DESC
```

### Error Rate by Operation
```
SELECT
  operation,
  COUNT(CASE WHEN result='failure' THEN 1 END) * 100.0 / COUNT(*) as error_rate,
  COUNT(*) as total_requests
FROM telemetry
GROUP BY operation
HAVING COUNT(*) > 100
ORDER BY error_rate DESC
```

### User Activity
```
SELECT
  userId,
  COUNT(*) as action_count,
  COUNT(DISTINCT DATE(timestamp)) as active_days
FROM telemetry
WHERE actorType='user'
GROUP BY userId
ORDER BY action_count DESC
LIMIT 20
```

### Conversion Funnel
```
SELECT
  operation,
  COUNT(*) as attempts,
  COUNT(CASE WHEN result='success' THEN 1 END) as successes,
  ROUND(COUNT(CASE WHEN result='success' THEN 1 END) * 100.0 / COUNT(*), 2) as success_rate
FROM telemetry
WHERE operation IN ('bond_purchase', 'coupon_distribution', 'order_execution')
GROUP BY operation
```

### P95 Latency by Hour
```
SELECT
  DATE_TRUNC('hour', timestamp) as hour,
  operation,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY durationMs) as p95_latency_ms
FROM telemetry
WHERE result='success'
GROUP BY hour, operation
ORDER BY hour DESC, p95_latency_ms DESC
```

## Sensitive Data Handling

### Automatically Redacted
- Authorization headers
- Tokens and secrets
- Stellar addresses (partially masked: `GXXXXXX...XXXX`)
- Private keys
- Signatures

### Example
Original:
```json
{
  "authorization": "Bearer eyJhbGc...",
  "walletAddress": "GBUQWP3BOUZX34UXVXGJ7FFVD4XRWAXZNQVX7ZLQS..."
}
```

Redacted:
```json
{
  "authorization": "[REDACTED]",
  "walletAddress": "GBUQW...ZLQS"
}
```

## Log Format

All telemetry is emitted as structured JSON:

```json
{
  "timestamp": "2026-09-26T12:00:00Z",
  "logger": "TELEMETRY",
  "level": "LOG",
  "message": {
    "operation": "bond_purchase",
    "actorType": "user",
    "result": "success",
    "durationMs": 234,
    "correlationId": "req-abc123",
    "userId": "user-456",
    "businessMetric": {
      "bondId": "bond-789",
      "investmentAmount": "1000000"
    }
  }
}
```

## Metrics to Monitor

### SLOs (Service Level Objectives)

1. **Request Latency**
   - p99: < 500ms for API endpoints
   - p95: < 300ms for critical path operations
   - Alert on > 1s for 5+ minutes

2. **Error Rate**
   - Target: < 0.1% error rate
   - Alert on > 1% error rate for 5+ minutes
   - Critical: > 5% error rate

3. **Job Processing**
   - Max queue size: < 1000 jobs
   - Average processing time: < 30s
   - Alert on dead-letter jobs > 10

4. **Data Export Success Rate**
   - Target: > 99%
   - Monitor: avg export size, avg processing time

5. **Reconciliation Drift**
   - Monitor: drifts found per run
   - Alert on > threshold drifts

## Best Practices

1. **Use Correlation IDs** - Always include in cross-service calls
2. **Classify Operations** - Use clear, consistent operation names
3. **Business Metrics** - Include domain-specific metrics (amounts, counts)
4. **Don't Log PII** - Redaction is automatic but verify
5. **Actionable Alerts** - Only alert on issues requiring action
6. **SLOs First** - Define SLOs before monitoring

## Integration Examples

### With Datadog
```typescript
import { Tracer } from 'dd-trace';

const tracer = Tracer.init({ service: 'verdant-api' });

telemetry.emit({
  operation: 'bond_purchase',
  correlationId: tracer.extract('http_headers', headers),
  // ...
});
```

### With Prometheus
```typescript
const latencyHistogram = new prometheus.Histogram({
  name: 'operation_duration_ms',
  help: 'Operation duration',
  labelNames: ['operation', 'result'],
});

telemetry.on('emit', (fields) => {
  latencyHistogram
    .labels(fields.operation, fields.result)
    .observe(fields.durationMs);
});
```

### With ELK Stack
All JSON telemetry logs are automatically parseable by Logstash for indexing in Elasticsearch.
