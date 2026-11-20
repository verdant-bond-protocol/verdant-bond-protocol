import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { IntentReceiptInterceptor } from '../../intent-receipts/intent-receipt.interceptor';

export const REQUIRE_INTENT_KEY = 'requireIntent';

export interface RequireIntentMeta {
  action: string;
  /** Route param (or body) key that identifies the action's target. */
  targetKey?: string;
  /** Fixed target value when there is no per-request target (e.g. global). */
  fixedTarget?: string;
}

/**
 * Marks an admin endpoint as requiring a signed step-up intent (#115).
 *
 * Also attaches IntentReceiptInterceptor so every protected action produces
 * a signed intent receipt that is finalised with the action's outcome (see
 * docs/maintainer-intent-receipts.md). Routes cannot opt into the intent
 * check without also producing receipts.
 *
 * @param action   the intent action name (e.g. 'issue_bond', 'distribute_coupon').
 * @param targetKey route param key whose value becomes the intent target (default 'id').
 * @param fixedTarget when set, the target is this constant (e.g. 'global').
 */
export const RequireIntent = (action: string, targetKey = 'id', fixedTarget?: string): MethodDecorator => {
  return applyDecorators(
    SetMetadata(REQUIRE_INTENT_KEY, { action, targetKey, fixedTarget } as RequireIntentMeta),
    UseInterceptors(IntentReceiptInterceptor),
  ) as MethodDecorator;
};
