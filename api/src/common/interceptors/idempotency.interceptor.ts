import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ConflictException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { IdempotencyService } from '../services/idempotency.service';
import { IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';

/**
 * Idempotency interceptor (#114). Active only on routes decorated with
 * @Idempotent AND when the client supplies an `Idempotency-Key` header.
 *
 * Behaviour:
 *  - Same key + same payload (fingerprint) and a completed result => returns
 *    the original result (deduplicated retry).
 *  - Same key + different payload => 409 Conflict.
 *  - Same key still pending => 409 Conflict (in progress; safe to poll).
 *  - No previous record => executes the handler and stores the result.
 *  - Previous error => exactly one concurrent retry claims the key and runs.
 *  - Key reserved but unreadable (stale read / Redis down) => 409, never runs.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isIdempotent) return next.handle();

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const key = request.headers?.['idempotency-key'];
    if (!key || typeof key !== 'string') return next.handle();

    const fingerprint = IdempotencyService.fingerprintOf(request.method, request.originalUrl || request.url, request.body);

    const existing = await this.idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ConflictException('Idempotency-Key reused with a different request payload');
      }
      if (existing.status === 'success') {
        if (typeof existing.statusCode === 'number') response.statusCode = existing.statusCode;
        return of(existing.result);
      }
      if (existing.status === 'pending') {
        throw new ConflictException('Request with this Idempotency-Key is already in progress');
      }
      // previous error: allow the retry to proceed
    }

    const acquired = await this.idempotency.markPending(key, fingerprint);
    if (!acquired) {
      const again = await this.idempotency.get(key);
      // A key we could not reserve but cannot read is a stale read or a Redis
      // outage. Executing would bypass deduplication, so fail closed (#348).
      if (!again) {
        throw new ConflictException('Idempotency state unavailable; retry with the same Idempotency-Key');
      }
      if (again.fingerprint !== fingerprint) {
        throw new ConflictException('Idempotency-Key reused with a different request payload');
      }
      if (again.status === 'success') {
        if (typeof again.statusCode === 'number') response.statusCode = again.statusCode;
        return of(again.result);
      }
      // 'pending', or 'error' with another retry already holding the claim.
      if (again.status === 'pending' || !(await this.idempotency.claimRetry(key, fingerprint))) {
        throw new ConflictException('Request with this Idempotency-Key is already in progress');
      }
    }

    return next.handle().pipe(
      tap({
        next: (result) => {
          const txHash = (result as any)?.transactionHash;
          const statusCode = response.statusCode;
          this.idempotency.complete(key, 'success', result, statusCode, fingerprint).catch(() => undefined);
          if (txHash) {
            // best-effort: keep the transaction hash on a side key for queries
          }
        },
        error: (err) => {
          this.idempotency
            .complete(key, 'error', { message: err?.message }, response.statusCode, fingerprint)
            .catch(() => undefined);
        },
      }),
    );
  }
}
