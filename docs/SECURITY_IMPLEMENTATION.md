# Security Implementation Guide

This document describes the security improvements implemented for the Verdant Bond Protocol.

## Canonical Input Normalization

### Overview

Ensures equivalent data produces identical canonical representations for signing, hashing, and settlement.

### Usage

```typescript
import {
  canonicalize,
  canonicalizeBondData,
} from "./common/utils/canonicalization.util";

// Canonicalize bond data for signing
const bondData = { bondId: "bond-123", amount: 1000.123 };
const canonical = canonicalizeBondData(bondData);

// Verify equivalence
if (areCanonicallyEqual(data1, data2)) {
  // Data is equivalent
}
```

### Features

- **Key Ordering**: Alphabetically sorts object keys
- **Whitespace Normalization**: Trims and normalizes spaces
- **Case Normalization**: Configurable lower/upper/none
- **Numeric Precision**: Rounds to specified decimal places
- **Legacy Support**: Transforms old field names

### Test Coverage

- ✅ Key ordering consistency
- ✅ Whitespace handling
- ✅ Case normalization
- ✅ Numeric precision
- ✅ Nested objects
- ✅ Arrays
- ✅ Date handling
- ✅ Legacy data transformation

## Webhook Verification (#272)

### Overview

Cryptographically verifies inbound webhooks and prevents replay attacks.

### Usage

```typescript
import { WebhookVerificationService } from "./webhooks/webhook-verification.service";

const config = {
  secret: process.env.WEBHOOK_SECRET,
  replayWindowMs: 5 * 60 * 1000, // 5 minutes
  signatureHeader: "x-webhook-signature",
  timestampHeader: "x-webhook-timestamp",
};

const result = webhookService.verifyWebhook(event, config);
if (!result.valid) {
  throw new UnauthorizedException(result.error);
}
```

### Features

- **HMAC Signature Verification**: SHA256-based signatures
- **Timing-Safe Comparison**: Prevents timing attacks
- **Replay Prevention**: Tracks processed event IDs
- **Stale Event Rejection**: Enforces time windows
- **Express Middleware**: Easy integration

### Test Coverage

- ✅ Valid webhook acceptance
- ✅ Invalid signature rejection
- ✅ Missing signature rejection
- ✅ Stale event rejection
- ✅ Future event rejection
- ✅ Replay attack prevention
- ✅ Structure validation

## Privacy-Preserving Analytics (#271)

### Overview

Aggregates usage metrics without exposing PII or sensitive data.

### Usage

```typescript
import { PrivacyPreservingAnalyticsService } from "./analytics/privacy-preserving-analytics.service";

// Record bond issuance
analyticsService.recordBondIssuance({
  bondType: "green",
  amountUsd: 1000000,
  durationMs: 1500,
  status: "success",
});

// Get aggregated metrics
const metrics = analyticsService.getAggregatedMetrics(startDate, endDate);
```

### Features

- **Safe Dimensions**: Only non-PII dimensions
- **Data Bucketing**: Groups sensitive values
- **Hash Anonymization**: Hashes identifiers
- **Aggregation**: Min/max/avg/count
- **Memory Management**: Auto-cleanup old data

### Safe Dimensions

- `event_type`
- `status`
- `bond_type`
- `error_code`
- `duration_bucket`
- `hour_of_day`

### Test Coverage

- ✅ PII filtering
- ✅ Dimension safety
- ✅ Metric aggregation
- ✅ Hash consistency
- ✅ Amount rounding
- ✅ Duration bucketing
- ✅ Period filtering

## Integration

### App Module Update

```typescript
import { WebhooksModule } from "./webhooks/webhooks.module";
import { AnalyticsModule } from "./analytics/analytics.module";

@Module({
  imports: [
    // ... existing imports
    WebhooksModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
```

### Environment Variables

```bash
# Webhook verification
WEBHOOK_SECRET=your-secret-key

# Analytics
ANALYTICS_RETENTION_HOURS=168  # 7 days
```

## Testing

Run all security-related tests:

```bash
# Canonicalization tests
npm test canonicalization.util.spec.ts

# Webhook verification tests
npm test webhook-verification.service.spec.ts

# Analytics tests
npm test privacy-preserving-analytics.service.spec.ts
```

## Deployment Checklist

- [ ] Set `WEBHOOK_SECRET` environment variable
- [ ] Configure webhook endpoints to use verification middleware
- [ ] Enable analytics recording for key events
- [ ] Review and update safe dimensions list
- [ ] Test webhook signature generation with partners
- [ ] Verify canonicalization doesn't break existing signatures
- [ ] Set up monitoring for failed webhook verifications
- [ ] Configure analytics retention policy

## Security Considerations

1. **Secrets Management**: Never commit secrets to git
2. **Signature Rotation**: Plan for webhook secret rotation
3. **Rate Limiting**: Apply to webhook endpoints
4. **Logging**: Never log raw webhook payloads
5. **Metrics Privacy**: Regularly audit safe dimensions
6. **Replay Window**: Balance security vs clock skew tolerance

## Operational Runbook

See [INCIDENT_RESPONSE.md](./runbooks/INCIDENT_RESPONSE.md) for:

- Incident triage procedures
- Emergency rollback steps
- Common incident resolutions
- Communication templates
- Validation commands
