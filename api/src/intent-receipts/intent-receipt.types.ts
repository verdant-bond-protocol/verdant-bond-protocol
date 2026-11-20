/**
 * Signed intent receipts for maintainer (admin) high-impact actions.
 *
 * Every endpoint decorated with `@RequireIntent` already demands a signed
 * step-up intent (#115). A receipt is the server's countersigned record of
 * what happened to that intent: it was rejected, it authorised an action that
 * is still running, or the action finished (succeeded or failed). Receipts are
 * kept so a reviewer can answer "who approved what, against which target, and
 * what was the outcome" after the fact. See docs/maintainer-intent-receipts.md.
 */

export const INTENT_RECEIPT_VERSION = 1;

/** Request property / response header carrying the receipt for this action. */
export const INTENT_RECEIPT_REQUEST_KEY = 'intentReceipt';
export const INTENT_RECEIPT_HEADER = 'x-intent-receipt-id';

/** Domain separation so a receipt signature can never be replayed as an intent. */
export const INTENT_RECEIPT_SIGNING_DOMAIN = 'verdant-intent-receipt:v1\n';

export type IntentReceiptStatus =
  /** Intent verified, action dispatched, outcome not yet known. */
  | 'authorized'
  /** Handler returned successfully. */
  | 'succeeded'
  /** Handler threw after the intent was accepted. */
  | 'failed'
  /** Intent was refused by IntentGuard; the action never ran. */
  | 'rejected';

export const TERMINAL_STATUSES: ReadonlySet<IntentReceiptStatus> = new Set([
  'succeeded',
  'failed',
  'rejected',
]);

export interface IntentReceiptOutcome {
  /** HTTP status sent (or that would be sent) for the action. */
  httpStatus: number;
  /** sha256 of the canonical response body, for successful actions. */
  resultDigest?: string;
  /** Stable error class name or code for failed/rejected actions. */
  errorCode?: string;
  /** Client-safe error message (HttpException message only, truncated). */
  errorMessage?: string;
  /** Set when the outcome was established by a reviewer rather than observed. */
  reconciledByReview?: string;
}

export type ReviewDisposition =
  /** Reviewer agrees the recorded outcome is correct. */
  | 'confirmed'
  /** Reviewer believes the action should not have been approved / was wrong. */
  | 'disputed'
  /** Outcome was unknown (stale `authorized`); reviewer verified it completed. */
  | 'reconciled_succeeded'
  /** Outcome was unknown (stale `authorized`); reviewer verified it did not take effect. */
  | 'reconciled_failed';

export const REVIEW_DISPOSITIONS: readonly ReviewDisposition[] = [
  'confirmed',
  'disputed',
  'reconciled_succeeded',
  'reconciled_failed',
];

export interface IntentReceiptReview {
  reviewId: string;
  reviewer: string;
  disposition: ReviewDisposition;
  note: string;
  reviewedAt: string;
  /** Receipt signature the reviewer was looking at, binding the review to that state. */
  receiptSignature: string;
  signature: string;
}

export interface IntentReceiptSigner {
  algorithm: 'ed25519';
  /** Stellar public key (G...) of the receipt signing key. */
  publicKey: string;
  /** True when no key was configured and a per-process key was generated. */
  ephemeral: boolean;
}

export interface IntentReceipt {
  version: number;
  receiptId: string;
  status: IntentReceiptStatus;

  // What was approved
  action: string;
  target: string;
  chain: string | null;
  nonce: string | null;
  intentExpiry: number | null;
  /** Admin's ed25519 signature over the canonical intent (base64), when one was presented. */
  intentSignature: string | null;
  /** sha256 of the canonical `action|target|chain|expiry|nonce` message. */
  intentDigest: string | null;
  /** Admin public key the intent was verified against (survives key rotation). */
  intentSigner: string | null;

  // Who / where
  actor: string;
  route: string;
  requestId: string | null;
  /** sha256 of the canonical request body (admin intent stripped). Never the raw body. */
  requestDigest: string;

  // When / outcome
  authorizedAt: string;
  completedAt: string | null;
  outcome: IntentReceiptOutcome | null;
  /** Rejection reason for `rejected` receipts. */
  rejectionReason: string | null;

  /** Hash of the audit-chain entry written for the latest transition. */
  auditHash: string | null;

  signer: IntentReceiptSigner;
  /** ed25519 signature (base64) over the canonical receipt body. */
  signature: string;

  reviews: IntentReceiptReview[];
}

/** A receipt as returned for review, with derived fields that are not signed. */
export interface IntentReceiptView extends IntentReceipt {
  /** `authorized` for longer than the stale threshold: outcome is unknown. */
  stale: boolean;
  /** True once a reviewer has reconciled or confirmed the receipt. */
  reviewed: boolean;
}

export interface IntentReceiptVerification {
  receiptId: string;
  /** Receipt signature matches its body and the server signing key. */
  receiptSignatureValid: boolean;
  /** Embedded admin intent signature matches the configured admin key (null if no intent). */
  intentSignatureValid: boolean | null;
  /** Each review signature is valid and bound to a receipt state. */
  reviewSignaturesValid: boolean;
  /** Audit chain for this receipt verifies end to end. */
  auditChainValid: boolean;
  ok: boolean;
  problems: string[];
}

export interface IntentReceiptQuery {
  status?: IntentReceiptStatus;
  action?: string;
  target?: string;
  actor?: string;
  staleOnly?: boolean;
  limit?: number;
}
