# Data Export Workflow

This document describes the data export feature that enables users and maintainers to export structured data with privacy safeguards.

## Overview

The data export system provides:
- Scoped data exports (portfolio, transactions, holdings, performance)
- Schema versioning for backward compatibility
- Authorization checks to prevent unauthorized access
- Automatic retention and expiration
- Background job processing for large exports

## Export Types

| Type | Description | Typical Size |
|------|-------------|--------------|
| PORTFOLIO | Complete investment portfolio with holdings | < 1 MB |
| TRANSACTIONS | All buy/sell/redemption transactions | < 10 MB |
| HOLDINGS | Current tranche holdings and balances | < 100 KB |
| PERFORMANCE | Historical performance metrics and returns | < 50 MB |

## Schema Versioning

Each export includes schema metadata for forward compatibility:

```json
{
  "id": "export-12345",
  "schema": {
    "version": "1.0.0",
    "generatedAt": "2026-09-26T12:00:00Z",
    "generatedBy": "user-123",
    "recordTypes": ["portfolio"],
    "retentionDays": 30
  },
  "recordCount": 1500,
  "data": [
    // Record array
  ]
}
```

### Version Evolution
- **1.0.0** - Initial schema with basic fields
- **1.1.0** (future) - Add new optional fields
- **2.0.0** (future) - Remove deprecated fields

Clients should handle unknown schema versions gracefully.

## Privacy & Security

### Authorization Checks
```
User can only access their own exports
```

Attempting to access another user's export returns 403 Forbidden:
```
GET /api/v1/exports/export-other-user
→ 403 Forbidden: Cannot access export outside your authorization scope
```

### Data Redaction
Personal identifiable information is excluded or minimized:
- Wallet addresses are shown (public blockchain data)
- Email addresses are never included
- Phone numbers are never included
- Complete names are minimized to initials

### Retention & Expiration
- Default retention: 30 days
- Exports automatically expire and are deleted
- Users can request deletion before expiration
- Compliance: Aligned with GDPR and privacy regulations

## API Endpoints

### 1. Request an Export
```
POST /api/v1/exports/request
Content-Type: application/json
Authorization: Bearer {token}

{
  "exportType": "portfolio"
}
```

Response:
```json
{
  "id": "export-abc123",
  "userId": "user-123",
  "status": "pending",
  "schema": {
    "version": "1.0.0",
    "generatedAt": "2026-09-26T12:00:00Z",
    "generatedBy": "user-123",
    "recordTypes": ["portfolio"],
    "retentionDays": 30
  },
  "recordCount": 0,
  "expiresAt": "2026-10-26T12:00:00Z",
  "createdAt": "2026-09-26T12:00:00Z"
}
```

### 2. Check Export Status
```
GET /api/v1/exports/export-abc123
Authorization: Bearer {token}
```

Response:
```json
{
  "id": "export-abc123",
  "userId": "user-123",
  "status": "processing",
  "recordCount": 750,
  "expiresAt": "2026-10-26T12:00:00Z",
  "createdAt": "2026-09-26T12:00:00Z"
}
```

### 3. Get Export Status
```
GET /api/v1/exports/status/export-abc123
Authorization: Bearer {token}
```

Response:
```json
{
  "status": "completed",
  "recordCount": 1500,
  "expiresAt": "2026-10-26T12:00:00Z"
}
```

## Export Lifecycle

### Immediate Availability (Small Exports)
For exports < 1 MB, data may be returned directly in response:
```
POST /api/v1/exports/request
→ 200 OK
{
  "id": "export-123",
  "status": "completed",
  "data": [ ... ]
}
```

### Background Processing (Large Exports)
For exports > 1 MB, processing happens asynchronously:

1. **User requests export:**
```
POST /api/v1/exports/request
→ 202 Accepted
{
  "id": "export-123",
  "status": "pending"
}
```

2. **Job enqueued in background:**
```
Job created: data_export
Payload: { exportId, userId, recordType }
```

3. **Worker processes export:**
```
Status: processing → collecting records
Status: processing → generating schema
Status: processing → writing to storage
```

4. **User polls for completion:**
```
GET /api/v1/exports/status/export-123
→ { "status": "completed", "recordCount": 5000, "filePath": "..." }
```

## Usage Examples

### Python Client
```python
import requests

# Request export
response = requests.post(
    'https://api.verdant.example/api/v1/exports/request',
    headers={'Authorization': f'Bearer {token}'},
    json={'exportType': 'portfolio'}
)
export_id = response.json()['id']

# Poll for completion
import time
while True:
    status = requests.get(
        f'https://api.verdant.example/api/v1/exports/{export_id}',
        headers={'Authorization': f'Bearer {token}'}
    ).json()
    
    if status['status'] == 'completed':
        print(f"Export ready: {status['recordCount']} records")
        break
    elif status['status'] == 'failed':
        print(f"Export failed: {status['error']}")
        break
    
    time.sleep(5)
```

### JavaScript/Node
```javascript
async function getPortfolioExport(token) {
  // Request
  const exportRes = await fetch(
    'https://api.verdant.example/api/v1/exports/request',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ exportType: 'portfolio' })
    }
  );
  const { id } = await exportRes.json();
  
  // Poll
  for (let i = 0; i < 60; i++) {
    const statusRes = await fetch(
      `https://api.verdant.example/api/v1/exports/status/${id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const status = await statusRes.json();
    
    if (status.status === 'completed') {
      return status;
    }
    
    await new Promise(r => setTimeout(r, 1000));
  }
  
  throw new Error('Export timeout');
}
```

## Error Handling

### Authorization Denied
```
403 Forbidden
Cannot access export outside your authorization scope
```

### Export Expired
```
404 Not Found
Export no longer available (retention period exceeded)
```

### Job Processing Failed
```
GET /api/v1/exports/export-123
→ 200 OK
{
  "id": "export-123",
  "status": "failed",
  "error": "Database connection timeout after 3 retries"
}
```

## Testing

### Manual Testing
```bash
# Request export
curl -X POST http://localhost:3000/api/v1/exports/request \
  -H "Authorization: Bearer $(get_token)" \
  -H "Content-Type: application/json" \
  -d '{"exportType": "portfolio"}'

# Check status
export_id=<from-response>
curl http://localhost:3000/api/v1/exports/status/$export_id \
  -H "Authorization: Bearer $(get_token)"
```

### Integration Tests
```typescript
describe('Data Export', () => {
  it('should export large portfolio without timeout', async () => {
    const response = await requestExport('PORTFOLIO');
    expect(response.status).toBe('pending');
    
    const exported = await pollForCompletion(response.id);
    expect(exported.status).toBe('completed');
    expect(exported.recordCount).toBeGreaterThan(1000);
  });

  it('should deny access to other users exports', async () => {
    const otherExport = await createExportAsOtherUser();
    const response = await getExport(otherExport.id);
    expect(response.status).toBe(403);
  });

  it('should expire exports after retention period', async () => {
    const exported = await createExport();
    fastForwardTime(31 * 24 * 60 * 60 * 1000); // 31 days
    const response = await getExport(exported.id);
    expect(response.status).toBe(404);
  });
});
```

## Performance Considerations

### Export Size Limits
- Small: < 1 MB → Synchronous
- Medium: 1-100 MB → Background job
- Large: > 100 MB → Consider chunked export or sampling

### Caching Strategy
- Export schemas cached for 1 hour
- User export history cached for 5 minutes
- Invalidate cache on new exports

### Database Query Optimization
- Use indexes on userId, createdAt
- Batch fetch records (1000 records per query)
- Stream results to avoid memory overflow

## Maintenance & Monitoring

### Metrics
```
export_request_count: Total exports requested
export_completed_count: Successfully completed exports
export_failed_count: Failed exports
export_processing_duration_ms: Average processing time
export_size_bytes: Average export size
```

### Health Checks
Monitor dead-letter jobs for export failures:
```
GET /api/v1/jobs/dead-letter/list
→ Filter for type='data_export' with error 'retry exhaustion'
```

## Future Enhancements

- [ ] Chunked exports (download large files in parts)
- [ ] Scheduled recurring exports
- [ ] Export format options (CSV, Parquet)
- [ ] Data validation before export
- [ ] Audit logging of all exports
- [ ] Encrypted exports
