import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditService } from '../../audit/audit.service';
import { AuditWrite } from '../../audit/classes/audit.classes';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly auditService: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const method = request.method;

    // We only audit sensitive actions (mutations)
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const user = request.user || { sub: 'anonymous' };
      const url = request.url;
      const body = { ...request.body };

      // Strip potential secrets before auditing
      delete body.password;
      delete body.secret;
      delete body.token;

      return next.handle().pipe(
        tap(async (response) => {
          const auditEvent: AuditWrite = {
            entityType: 'http_request',
            entityId: url,
            principal: user.sub,
            action: method,
            payload: JSON.stringify(body),
          };

          try {
            await this.auditService.record(auditEvent);
          } catch (e) {
            console.error('Failed to write audit event', e);
          }
        }),
      );
    }

    return next.handle();
  }
}
