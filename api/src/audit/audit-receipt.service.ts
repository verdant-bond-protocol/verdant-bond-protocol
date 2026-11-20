import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditRecord } from './audit.interface';
import { AuditWrite } from './classes/audit.classes';
import {
  AuditReceiptKeyPair,
  AuditReceiptVerification,
  SignedAuditReceipt,
  auditReceiptPublicKey,
  generateAuditReceiptKeyPair,
  signAuditReceipt,
  verifyAuditReceipt,
} from './audit.receipt';

/** Roles allowed to request a signed receipt for a privileged action. */
export const PRIVILEGED_AUDIT_ROLES = ['admin', 'auditor'] as const;
export type PrivilegedAuditRole = (typeof PRIVILEGED_AUDIT_ROLES)[number];

export interface AuditReceiptIssueResult {
  record: AuditRecord;
  receipt: SignedAuditReceipt;
}

/**
 * Issues and verifies signed audit receipts for privileged actions (#260).
 *
 * Additive to `AuditService`: the underlying hash chain and `AuditRecord` shape
 * are untouched. A receipt is a separate, Ed25519-signed object bound to one
 * audit entry. Without `AUDIT_RECEIPT_SIGNING_KEY` the service uses an
 * ephemeral key and warns — receipts then verify only within that process.
 */
@Injectable()
export class AuditReceiptService {
  private readonly logger = new Logger(AuditReceiptService.name);
  private readonly signer: AuditReceiptKeyPair;

  constructor(private readonly audit: AuditService) {
    const configured = process.env.AUDIT_RECEIPT_SIGNING_KEY;
    if (configured) {
      const privateKey = configured.replace(/\\n/g, '\n');
      try {
        this.signer = { privateKey, publicKey: auditReceiptPublicKey(privateKey) };
      } catch {
        // Fail closed: a misconfigured key must not silently become an
        // ephemeral one, which would make issued receipts unverifiable later.
        throw new Error('AUDIT_RECEIPT_SIGNING_KEY is not a valid PKCS#8 Ed25519 private key');
      }
    } else {
      this.signer = generateAuditReceiptKeyPair();
      this.logger.warn(
        'AUDIT_RECEIPT_SIGNING_KEY is not set; using an ephemeral audit receipt key. ' +
        'Receipts will not verify after a restart — configure a stable key in production.',
      );
    }
  }

  /** SPKI PEM of the key used to sign new receipts. Publish for verifiers. */
  get publicKey(): string {
    return this.signer.publicKey;
  }

  /** Records a privileged action and signs the resulting audit entry. */
  async recordPrivilegedAction(
    write: AuditWrite,
    options: { actorRoles?: readonly string[] } = {},
  ): Promise<AuditReceiptIssueResult> {
    // HTTP callers must pass roles from their guard. Internal callers that
    // omit the option keep the previous (unrestricted) behaviour.
    if (options.actorRoles && !options.actorRoles.some((r) => PRIVILEGED_AUDIT_ROLES.includes(r as PrivilegedAuditRole))) {
      throw new ForbiddenException('A signed audit receipt requires an admin or auditor actor');
    }

    const result = await this.audit.record(write);
    if (result.kind !== 'recorded' || !result.record) {
      throw new ServiceUnavailableException(
        `Audit receipt could not be issued: ${result.rejectReason || 'audit write rejected'}`,
      );
    }
    return { record: result.record, receipt: signAuditReceipt(result.record, this.signer) };
  }

  /** Signs an existing audit entry without writing a new one. */
  issue(record: AuditRecord): SignedAuditReceipt {
    return signAuditReceipt(record, this.signer);
  }

  /**
   * Verifies a receipt. By default only receipts from the current key are
   * trusted; pass `trustedPublicKeys` to accept receipts from rotated keys.
   */
  verify(
    record: AuditRecord,
    receipt: SignedAuditReceipt,
    trustedPublicKeys: readonly string[] = [this.signer.publicKey],
  ): AuditReceiptVerification {
    return verifyAuditReceipt(record, receipt, { trustedPublicKeys });
  }
}
