import { Injectable, CanActivate, ExecutionContext, Optional, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IntentService } from '../services/intent.service';
import { REQUIRE_INTENT_KEY, RequireIntentMeta } from '../decorators/require-intent.decorator';
import { IntentReceiptService, IntentRequestContext } from '../../intent-receipts/intent-receipt.service';
import { INTENT_RECEIPT_HEADER, INTENT_RECEIPT_REQUEST_KEY } from '../../intent-receipts/intent-receipt.types';

/**
 * Enforces signed admin step-up intents on endpoints decorated with
 * @RequireIntent (#115). Runs after AdminGuard, so the caller is already a
 * confirmed admin; this guard additionally proves a fresh, deliberate,
 * single-use authorisation for the specific action + target.
 *
 * When the intent receipts module is loaded, every decision also produces a
 * signed receipt: `rejected` when verification fails, `authorized` when it
 * passes (finalised by IntentReceiptInterceptor once the handler settles).
 */
@Injectable()
export class IntentGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly intentService: IntentService,
    @Optional() private readonly receipts?: IntentReceiptService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<RequireIntentMeta | undefined>(REQUIRE_INTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @RequireIntent on this route: not protected by step-up verification.
    if (!meta) return true;

    const request = context.switchToHttp().getRequest();
    const target = meta.fixedTarget ?? String(request.params?.[meta.targetKey ?? 'id'] ?? request.body?.[meta.targetKey ?? 'id'] ?? 'global');

    let raw: any;
    let intent;
    try {
      raw = this.extractIntent(request);
      intent = await this.intentService.verify(raw, meta.action, target);
    } catch (error) {
      if (this.receipts) {
        // Recording a rejection must never mask the original 401/409.
        try {
          const receipt = await this.receipts.reject(meta.action, target, raw, error, this.requestContext(request));
          this.attach(context, receipt.receiptId);
        } catch {
          // The request is refused either way.
        }
      }
      throw error;
    }

    if (this.receipts) {
      // Fail closed: if the receipt cannot be issued the action does not run.
      // The nonce is already consumed, so the maintainer must re-sign.
      const receipt = await this.receipts.authorize(intent, this.requestContext(request));
      request[INTENT_RECEIPT_REQUEST_KEY] = receipt;
      this.attach(context, receipt.receiptId);
    }
    return true;
  }

  private requestContext(request: any): IntentRequestContext {
    return {
      actor: request.user?.walletAddress ?? 'anonymous',
      route: `${request.method ?? 'UNKNOWN'} ${request.route?.path ?? request.url ?? ''}`,
      requestId: request.requestId ?? request.correlationId ?? null,
      body: request.body,
    };
  }

  private attach(context: ExecutionContext, receiptId: string): void {
    context.switchToHttp().getResponse()?.setHeader?.(INTENT_RECEIPT_HEADER, receiptId);
  }

  private extractIntent(request: any): any {
    const header = request.headers?.['x-admin-intent'];
    if (header) {
      try {
        return typeof header === 'string' ? JSON.parse(header) : header;
      } catch {
        throw new UnauthorizedException('Admin intent header is not valid JSON');
      }
    }
    if (request.body?.adminIntent) {
      return request.body.adminIntent;
    }
    return undefined;
  }
}
