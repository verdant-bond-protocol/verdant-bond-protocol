import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import * as crypto from 'crypto';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = /(authorization|token|secret|signature|signed|xdr|private|password|transaction|tx)/i;
const WALLET_KEY_PATTERN = /(wallet|address|account|issuer|holder|investor|from|to)/i;
const STELLAR_ADDRESS_PATTERN = /\bG[A-Z2-7]{20,60}\b/g;

export function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(STELLAR_ADDRESS_PATTERN, (match) => `${match.slice(0, 6)}...${match.slice(-4)}`);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item));
  }
  if (value && typeof value === 'object') {
    return redactLogObject(value as Record<string, unknown>);
  }
  return value;
}

export function redactLogObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        return [key, REDACTED];
      }
      if (WALLET_KEY_PATTERN.test(key) && typeof value === 'string') {
        return [key, redactLogValue(value)];
      }
      return [key, redactLogValue(value)];
    }),
  );
}

export function resolveCorrelationId(request: any): string {
  const incoming = request.headers?.['x-correlation-id'] || request.headers?.['x-request-id'];
  return typeof incoming === 'string' && incoming.trim()
    ? incoming.trim().slice(0, 128)
    : crypto.randomUUID();
}

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const requestId = resolveCorrelationId(request);
    request.requestId = requestId;
    request.correlationId = requestId;
    response?.setHeader?.('x-correlation-id', requestId);

    const start = Date.now();
    this.logger.log(
      JSON.stringify({
        event: 'http_request',
        correlationId: requestId,
        method: request.method,
        url: request.url,
        body: redactLogValue(request.body),
        headers: redactLogObject(request.headers ?? {}),
      }),
    );

    return next.handle().pipe(
      tap({
        next: () =>
          this.logger.log(
            JSON.stringify({
              event: 'http_response',
              correlationId: requestId,
              durationMs: Date.now() - start,
            }),
          ),
        error: (err) =>
          this.logger.error(
            JSON.stringify({
              event: 'http_error',
              correlationId: requestId,
              durationMs: Date.now() - start,
              error: err?.message,
              meta: redactLogValue(err),
            }),
            err.stack,
          ),
      }),
    );
  }
}
