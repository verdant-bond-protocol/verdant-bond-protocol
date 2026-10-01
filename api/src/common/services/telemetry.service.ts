import { Injectable, Logger } from '@nestjs/common';

export interface TelemetryFields {
  operation: string;
  actorType: 'user' | 'service' | 'system' | 'admin';
  result: 'success' | 'failure' | 'partial';
  durationMs: number;
  correlationId: string;
  userId?: string;
  businessMetric?: Record<string, number | string>;
  error?: string;
  errorCode?: string;
}

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger('TELEMETRY');

  emit(fields: TelemetryFields): void {
    const sanitized = this.sanitizeFields(fields);
    this.logger.log(JSON.stringify(sanitized));
  }

  private sanitizeFields(fields: TelemetryFields): Partial<TelemetryFields> {
    const { userId, businessMetric, ...rest } = fields;
    return {
      ...rest,
      ...(userId && { userId }),
      ...(businessMetric && { businessMetric }),
    };
  }
}
