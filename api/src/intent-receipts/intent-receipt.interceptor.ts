import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Optional } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { from, Observable, throwError } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';
import { INTENT_RECEIPT_REQUEST_KEY, IntentReceipt } from './intent-receipt.types';
import { IntentReceiptService } from './intent-receipt.service';

/**
 * Finalises the receipt IntentGuard opened for a `@RequireIntent` action:
 * `succeeded` with a digest of the response, or `failed` with a client-safe
 * error description. The receipt is finalised *before* the response is sent,
 * so a client that receives a response can immediately fetch a terminal
 * receipt. A failure to finalise never changes the action's own response.
 *
 * Applied automatically by the `@RequireIntent` decorator.
 */
@Injectable()
export class IntentReceiptInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly receipts?: IntentReceiptService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const receipt: IntentReceipt | undefined = request?.[INTENT_RECEIPT_REQUEST_KEY];
    if (!this.receipts || !receipt) return next.handle();

    const receipts = this.receipts;
    const httpStatus = this.successStatus(context, request);

    return next.handle().pipe(
      concatMap((body) =>
        from(
          receipts
            .complete(receipt.receiptId, { ok: true, httpStatus, body })
            .catch(() => undefined)
            .then(() => body),
        ),
      ),
      catchError((error) =>
        from(receipts.complete(receipt.receiptId, { ok: false, error }).catch(() => undefined)).pipe(
          concatMap(() => throwError(() => error)),
        ),
      ),
    );
  }

  private successStatus(context: ExecutionContext, request: any): number {
    const declared = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler());
    if (declared) return declared;
    return request?.method === 'POST' ? 201 : 200;
  }
}
