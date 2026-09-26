import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { TelemetryService } from '../services/telemetry.service';

@Injectable()
export class TelemetryInterceptor implements NestInterceptor {
  constructor(private readonly telemetry: TelemetryService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const correlationId = request.correlationId || request.requestId;
    const startTime = Date.now();
    const operation = `${request.method} ${request.path}`;

    return next.handle().pipe(
      tap(() => {
        this.telemetry.emit({
          operation,
          actorType: this.getActorType(request),
          result: 'success',
          durationMs: Date.now() - startTime,
          correlationId,
          userId: request.user?.sub,
        });
      }),
      catchError((error) => {
        this.telemetry.emit({
          operation,
          actorType: this.getActorType(request),
          result: 'failure',
          durationMs: Date.now() - startTime,
          correlationId,
          userId: request.user?.sub,
          error: error.message,
          errorCode: error.code || error.statusCode,
        });
        throw error;
      }),
    );
  }

  private getActorType(request: any): 'user' | 'service' | 'system' | 'admin' {
    if (!request.user) return 'system';
    if (request.user.role === 'admin') return 'admin';
    if (request.user.role === 'service') return 'service';
    return 'user';
  }
}
