# Background Worker Framework

This document describes the background worker framework implemented to handle delayed and retryable tasks in the Verdant Bond Protocol API.

## Overview

The worker framework provides:
- Job queueing and persistence in Redis
- Automatic retry with exponential backoff
- Dead-letter handling for failed jobs
- Job status tracking and introspection
- Telemetry integration for monitoring

## Architecture

### Components

1. **JobQueueService** - Manages job storage, enqueuing, and state transitions
2. **WorkerService** - Executes jobs using registered handlers
3. **JobHandler** - Interface for implementing job processing logic
4. **Jobs Controller** - HTTP API for job management

### Job Lifecycle

```
PENDING → PROCESSING → SUCCESS
       ↓
       └→ PENDING (retry) → ...
                ↓
              DEAD_LETTER (max retries exceeded)
```

## Usage

### 1. Registering a Job Handler

```typescript
import { JobHandler } from '@/workers/services/worker.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class MyJobHandler implements JobHandler {
  async handle(payload: any): Promise<Record<string, any>> {
    // Process the job
    console.log('Processing job with payload:', payload);
    return { result: 'success' };
  }
}
```

### 2. Enqueuing a Job

In your service or controller:

```typescript
import { JobQueueService } from '@/workers/services/job-queue.service';
import { JobType, JobPayload } from '@/workers/interfaces/job.interface';

export class MyService {
  constructor(private readonly jobQueue: JobQueueService) {}

  async enqueueMyJob() {
    const payload: JobPayload = {
      type: JobType.CUSTOM_JOB,
      data: { myData: 'value' },
      userId: 'user-123',
      correlationId: 'correlation-id',
    };

    const job = await this.jobQueue.enqueue(payload, 3); // Max 3 retries
    return job;
  }
}
```

### 3. Starting the Worker

In your main.ts or a scheduled task:

```typescript
import { WorkerService } from '@/workers/services/worker.service';
import { JobType } from '@/workers/interfaces/job.interface';

// After app initialization
const workerService = app.get(WorkerService);

// Register handlers
workerService.registerHandler(JobType.RECONCILIATION, reconciliationHandler);
workerService.registerHandler(JobType.DATA_EXPORT, dataExportHandler);

// Start processing jobs
workerService.startProcessing(5000); // Check every 5 seconds
```

## Job Types

Currently supported job types:

| Type | Handler | Purpose |
|------|---------|---------|
| RECONCILIATION | ReconciliationJobHandler | Run reconciliation checks |
| DATA_EXPORT | DataExportJobHandler | Generate data exports |
| COUPON_DISTRIBUTION | — | Distribute coupons to holders |
| ORACLE_SYNC | — | Sync oracle data |
| PORTFOLIO_REBALANCE | — | Rebalance investor portfolios |

## API Endpoints

### Enqueue a Job
```
POST /api/v1/jobs/enqueue
Content-Type: application/json

{
  "type": "reconciliation",
  "data": { "dryRun": true }
}
```

Response:
```json
{
  "id": "job-uuid",
  "type": "reconciliation",
  "status": "pending",
  "retries": 0,
  "maxRetries": 3,
  "createdAt": "2026-09-26T12:00:00Z"
}
```

### Get Job Status
```
GET /api/v1/jobs/{jobId}
```

Response:
```json
{
  "id": "job-uuid",
  "status": "processing",
  "startedAt": "2026-09-26T12:00:01Z",
  "payload": { ... }
}
```

### Get Queue Status (Admin)
```
GET /api/v1/jobs/queue/status
```

### Get Dead-Letter Jobs (Admin)
```
GET /api/v1/jobs/dead-letter/list
```

## Retry Policy

- **Max Retries**: 3 (configurable per job)
- **Job Timeout**: 5 minutes
- **Processing Interval**: 5 seconds (configurable)
- **Dead-Letter**: Jobs exceed max retries are moved to dead-letter status

Failed jobs preserve error messages and context for debugging:
```json
{
  "id": "job-uuid",
  "status": "failed",
  "retries": 2,
  "maxRetries": 3,
  "lastError": "Database connection timeout",
  "lastErrorAt": "2026-09-26T12:00:30Z"
}
```

## Local Development

### Running the Worker Locally

1. Ensure Redis is running:
```bash
redis-server
```

2. Start the API with worker processing:
```bash
npm run start:dev
```

3. The worker will automatically start processing jobs from the queue

### Testing Jobs Locally

```bash
# Enqueue a reconciliation job
curl -X POST http://localhost:3000/api/v1/jobs/enqueue \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "type": "reconciliation",
    "data": { "dryRun": true }
  }'

# Check job status
curl http://localhost:3000/api/v1/jobs/{jobId} \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Telemetry

All job processing is automatically tracked in telemetry logs with:
- Operation name: `job:{jobType}`
- Actor type: `system`
- Execution duration in milliseconds
- Correlation ID for tracing
- Success/failure result with error details

Example telemetry entry:
```json
{
  "event": "telemetry",
  "operation": "job:reconciliation",
  "actorType": "system",
  "result": "success",
  "durationMs": 1234,
  "correlationId": "correlation-id"
}
```

## Migration from Request Handlers

To migrate long-running operations from request handlers to background jobs:

### Before (Blocking Request)
```typescript
@Post('export')
async requestExport() {
  const data = await this.expensiveOperation(); // Blocks for minutes
  return data;
}
```

### After (Background Job)
```typescript
@Post('export')
async requestExport() {
  const job = await this.jobQueue.enqueue({
    type: JobType.DATA_EXPORT,
    data: { /* params */ }
  });
  return { jobId: job.id, status: 'pending' };
}
```

Client polls `/api/v1/jobs/{jobId}` for completion.

## Best Practices

1. **Keep Jobs Focused** - Each handler should do one thing well
2. **Idempotent Handlers** - Handlers should be safe to retry
3. **Preserve Context** - Include correlation ID in job payload for tracing
4. **Limit Data** - Store only necessary data in job payloads (Redis memory)
5. **Monitor Dead-Letter** - Regularly check dead-letter jobs for issues
6. **Test Locally** - Always test job handlers before deploying

## Troubleshooting

### Job Stuck in Processing State

A job may be stuck if the worker crashed during processing:

1. Check dead-letter jobs: `GET /api/v1/jobs/dead-letter/list`
2. Manually inspect job: `GET /api/v1/jobs/{jobId}`
3. If stuck > 10 minutes, the processing lock will auto-expire (configurable via `JOB_PROCESSING_TIMEOUT_MS`)

### Handler Not Registered

Error: "No handler registered for job type"

Solution: Ensure your module registers the handler before starting the worker.

### High Job Processing Latency

- Increase processing interval if CPU is saturated
- Add more worker instances (scale horizontally)
- Optimize handler implementation

## Future Enhancements

- [ ] Scheduled/delayed job execution
- [ ] Job prioritization (HIGH, NORMAL, LOW)
- [ ] Distributed worker pool
- [ ] Job progress tracking
- [ ] WebSocket job status updates
