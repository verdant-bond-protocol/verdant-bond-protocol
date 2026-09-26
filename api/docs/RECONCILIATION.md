# Reconciliation Service

This document describes the reconciliation job that detects and reports drift between the stored database, investor ledger, and external settlement references.

## Overview

The reconciliation service provides:
- Dry-run reports without modifying production data
- Detection of four types of data drift
- Repair suggestions for detected issues
- Integration with background worker framework
- Admin-accessible API for manual reconciliation runs

## Drift Types Detected

### 1. Missing Records
A record is expected based on invariants but not found:

```json
{
  "type": "missing",
  "entityType": "holding",
  "entityId": "holding-123",
  "description": "Bond tranche holding not found in portfolio after purchase",
  "affectedFields": ["quantity", "value"],
  "repairSuggestion": "Create missing holding record from transaction log"
}
```

### 2. Duplicate Records
Multiple records exist when only one should:

```json
{
  "type": "duplicate",
  "entityType": "transaction",
  "entityId": "txn-456",
  "description": "Transaction recorded twice in ledger",
  "affectedFields": ["amount", "timestamp"],
  "repairSuggestion": "Remove duplicate transaction and reconcile balance"
}
```

### 3. Stale Records
A record exists but is outdated or no longer valid:

```json
{
  "type": "stale",
  "entityType": "coupon_payment",
  "entityId": "coupon-789",
  "description": "Coupon marked as pending but scheduled date passed 30 days ago",
  "expectedValue": "distributed",
  "actualValue": "pending",
  "repairSuggestion": "Mark coupon as distributed or investigate why payment didn't occur"
}
```

### 4. Inconsistent Records
A record's data is logically inconsistent:

```json
{
  "type": "inconsistent",
  "entityType": "bond_holding",
  "entityId": "holding-101",
  "description": "Holding quantity negative (impossible state)",
  "expectedValue": "> 0",
  "actualValue": "-100",
  "repairSuggestion": "Review transaction history and adjust quantity to actual purchased amount"
}
```

## Reconciliation Invariants

Domain rules that must always hold true:

### 1. Holdings Invariant
```
For every transaction of type PURCHASE:
  ∃ holding in portfolio where holding.quantity ≥ txn.quantity
```

### 2. Balance Invariant
```
For a user portfolio:
  sum(holdings) = sum(purchases) - sum(sales)
```

### 3. Coupon Payment Invariant
```
For each bond tranche with coupon payment:
  coupon_payment.status in ['pending', 'processing', 'distributed']
  AND scheduled_date <= now + 60 days
```

### 4. Stellar Settlement Invariant
```
For each recorded trade:
  ∃ corresponding on-chain transaction with matching amount/parties
```

## API Endpoints

### 1. Run Dry-Run Reconciliation
```
POST /api/v1/reconciliation/dry-run
Authorization: Bearer {admin-token}
```

Response (no modifications):
```json
{
  "timestamp": "2026-09-26T12:00:00Z",
  "dryRun": true,
  "totalEntitiesChecked": 5432,
  "driftsFound": [
    {
      "type": "missing",
      "entityType": "holding",
      "entityId": "holding-123",
      "description": "..."
    }
  ],
  "summary": {
    "missingCount": 2,
    "duplicateCount": 1,
    "staleCount": 15,
    "inconsistentCount": 3
  }
}
```

### 2. Enqueue Reconciliation Job
```
POST /api/v1/reconciliation/enqueue-job
Authorization: Bearer {admin-token}

{
  "dryRun": true
}
```

Response:
```json
{
  "id": "job-abc123",
  "type": "reconciliation",
  "status": "pending",
  "payload": {
    "dryRun": true
  },
  "createdAt": "2026-09-26T12:00:00Z"
}
```

### 3. Get Reconciliation Status
```
GET /api/v1/reconciliation/status
Authorization: Bearer {admin-token}
```

Response:
```json
{
  "invariantCount": 4,
  "lastRunTime": "2026-09-26T12:00:00Z",
  "lastDriftCount": 21
}
```

## Reconciliation Workflow

### Immediate (Dry-Run)
```
POST /api/v1/reconciliation/dry-run
→ Runs synchronously
→ Returns full report immediately
→ No database modifications
```

### Background (Full Reconciliation)
```
POST /api/v1/reconciliation/enqueue-job
→ Creates background job
→ Worker processes with retries
→ Report available via job endpoint
```

### Example Dry-Run Flow
```bash
# 1. Start dry-run
curl -X POST http://localhost:3000/api/v1/reconciliation/dry-run \
  -H "Authorization: Bearer $(get_admin_token)"

# Response includes drifts found:
{
  "dryRun": true,
  "driftsFound": [
    {
      "type": "missing",
      "entityType": "holding",
      "entityId": "holding-123",
      "repairSuggestion": "Create missing holding record from transaction log"
    }
  ]
}

# 2. Review suggestions
# 3. Coordinate repairs with engineering team
# 4. Run full reconciliation after fixing
```

## Repair Workflow

Reconciliation reports suggest repairs but do NOT auto-apply to prevent accidental data loss:

### Safe Manual Repair Process
```
1. Run dry-run reconciliation
2. Export full report with suggestions
3. Review each suggested repair
4. Implement repairs manually or with admin scripts
5. Run dry-run again to verify
6. Document changes in audit log
```

### Example Repair
```typescript
// After reconciliation identifies missing holding:
// holding-123 for user-456 on bond-789

async function repairMissingHolding(userId: string, bondId: string, quantity: string) {
  // 1. Verify from transaction log
  const txn = await getTransaction(userId, bondId);
  if (!txn) {
    throw new Error('No source transaction found - cannot repair');
  }
  
  // 2. Create holding
  const holding = await createHolding({
    userId,
    bondId,
    quantity: txn.quantity,
    createdAt: txn.createdAt,
  });
  
  // 3. Audit log
  await auditLog.record({
    action: 'holding_repair',
    entityType: 'holding',
    entityId: holding.id,
    repair_reason: 'reconciliation_drift_missing',
    source: 'transaction_' + txn.id,
  });
}
```

## Integration with Worker Framework

Reconciliation is implemented as a job handler:

```typescript
// In background worker:
class ReconciliationJobHandler implements JobHandler {
  async handle(payload: any) {
    const { dryRun = true } = payload;
    
    const report = await this.reconciliation.reconcile(dryRun);
    
    return {
      reportId: `reconciliation-${Date.now()}`,
      driftsFound: report.driftsFound.length,
      summary: report.summary,
    };
  }
}

// In app initialization:
workerService.registerHandler(
  JobType.RECONCILIATION,
  reconciliationJobHandler
);
```

## Monitoring & Alerts

### Metrics to Track
```
reconciliation_run_duration_ms
  - Average time to run full reconciliation
  - Alert on > 30 minutes (potential DB performance issue)

reconciliation_drifts_found_count
  - Number of drifts detected per run
  - Alert on > 100 drifts (potential systemic issue)

reconciliation_drift_type_distribution
  - Count by type (missing, duplicate, stale, inconsistent)
  - Track if one type dominates

reconciliation_job_failure_rate
  - Reconciliation job success rate
  - Alert on > 5% failures
```

### Dashboard Queries
```sql
-- Drift trend
SELECT
  DATE_TRUNC('day', timestamp) as day,
  SUM(driftsFound) as total_drifts,
  AVG(driftsFound) as avg_drifts
FROM reconciliation_reports
WHERE dryRun = false
GROUP BY day
ORDER BY day DESC
LIMIT 30;

-- Most common drift entity types
SELECT
  entityType,
  type as driftType,
  COUNT(*) as count
FROM reconciliation_drifts
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY entityType, driftType
ORDER BY count DESC;

-- Repair success rate
SELECT
  COUNT(CASE WHEN repaired_at IS NOT NULL THEN 1 END) * 100.0 / COUNT(*) as repair_rate
FROM reconciliation_drifts
WHERE found_at > NOW() - INTERVAL '30 days';
```

## Testing

### Unit Tests
```typescript
describe('ReconciliationService', () => {
  it('should detect missing holding', async () => {
    // Create transaction without holding
    const txn = await createPurchaseTransaction(user, bond, quantity);
    await deleteHolding(user, bond);
    
    const report = await service.runDryRun();
    
    expect(report.summary.missingCount).toBeGreaterThan(0);
    expect(report.driftsFound[0].type).toBe('missing');
  });

  it('should detect duplicate transactions', async () => {
    const txn = await createPurchaseTransaction(user, bond, quantity);
    await duplicateTransaction(txn);
    
    const report = await service.runDryRun();
    
    expect(report.summary.duplicateCount).toBeGreaterThan(0);
  });

  it('should detect stale coupon payments', async () => {
    const coupon = await createCouponPayment(bond, { scheduledAt: pastDate });
    coupon.status = 'pending'; // Stuck
    await save(coupon);
    
    const report = await service.runDryRun();
    
    expect(report.summary.staleCount).toBeGreaterThan(0);
  });

  it('should detect inconsistent holdings', async () => {
    const holding = await getHolding(user, bond);
    holding.quantity = '-100'; // Invalid
    await save(holding);
    
    const report = await service.runDryRun();
    
    expect(report.summary.inconsistentCount).toBeGreaterThan(0);
  });
});
```

## Performance & Scaling

### Optimization
- Reconciliation runs as background job (non-blocking)
- Invariant checks run in parallel where possible
- Index database queries on frequently checked fields
- Cache invariant results for 1 hour

### Scaling Considerations
- For tables > 1M rows, consider sharded reconciliation
- Run reconciliation during off-peak hours
- Implement incremental reconciliation (only changed data)
- Archive reconciliation reports after 90 days

### Expected Runtimes
- Small system (< 10k users): 2-5 minutes
- Medium system (10k-100k users): 10-30 minutes
- Large system (> 100k users): 30-120 minutes

## Troubleshooting

### Reconciliation Stuck in Processing
Check if database queries are slow:
```sql
EXPLAIN ANALYZE
SELECT COUNT(*) FROM holdings WHERE updated_at > NOW() - INTERVAL '1 day';
```

### High Drift Count
May indicate systemic issue:
1. Check for recent code deployments
2. Review application error logs
3. Check database integrity
4. Run incremental reconciliation on specific entity types

### Reconciliation Reports Growing
Implement report archival:
```typescript
// Archive reports older than 90 days
await reconciliationReports.deleteWhere({
  createdAt: { $lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) }
});
```

## Future Enhancements

- [ ] Incremental reconciliation (only changed data)
- [ ] Automatic repair for low-risk drifts
- [ ] Reconciliation on-demand by entity type
- [ ] Real-time drift detection vs batch
- [ ] Reconciliation report export (CSV, JSON)
- [ ] Audit trail for all repairs
- [ ] Multi-step approval for auto-repairs
