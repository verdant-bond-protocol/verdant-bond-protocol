import { createPublicKey, generateKeyPairSync, sign, verify } from 'crypto';
import { stableStringify } from './audit.canonical';
import { AuditRecord } from './audit.interface';

/** Version of the signed-receipt wire format. Bump on any field change. */
export const AUDIT_RECEIPT_VERSION = 1;

/** Domain separator: prevents a receipt from being replayed in another scheme. */
export const AUDIT_RECEIPT_DOMAIN = 'verdant-audit-receipt:v1\n';

export interface AuditReceiptKeyPair {
  /** SPKI PEM public key. */
  publicKey: string;
  /** PKCS#8 PEM private key. */
  privateKey: string;
}

export interface SignedAuditReceipt {
  version: number;
  recordId: string;
  /** SHA-256 content hash of the underlying audit entry. */
  hash: string;
  /** Base64 Ed25519 signature over the canonical receipt message. */
  signature: string;
  signerPublicKey: string;
  action: string;
  actor: string;
  entityType: string;
  entityId: string;
}

export type AuditReceiptFailureReason =
  | 'unsupported_version'
  | 'malformed_receipt'
  | 'record_mismatch'
  | 'untrusted_signer'
  | 'signature_mismatch';

export type AuditReceiptVerification =
  | { ok: true }
  | { ok: false; reason: AuditReceiptFailureReason };

/**
 * Canonical, domain-separated message bound to every authoritative field of an
 * audit entry. `stableStringify` sorts object keys recursively, so the same
 * record always produces the same bytes on every host.
 */
export function auditReceiptMessage(record: AuditRecord): string {
  return AUDIT_RECEIPT_DOMAIN + stableStringify({
    recordId: record.recordId,
    sequence: record.sequence,
    entityType: record.entityType,
    entityId: record.entityId,
    action: record.action,
    actor: record.actor,
    reason: record.reason ?? null,
    before: record.before ?? null,
    after: record.after ?? null,
    recordedAt: record.recordedAt,
    previousHash: record.previousHash ?? null,
    hash: record.hash,
  });
}

/** Generates an Ephemeral Ed25519 key pair (used when no key is configured). */
export function generateAuditReceiptKeyPair(): AuditReceiptKeyPair {
  const pair = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/** Derives the SPKI public key from a configured PKCS#8 private key. */
export function auditReceiptPublicKey(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem)
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

/** Signs an audit entry, producing a receipt bound to that exact entry. */
export function signAuditReceipt(record: AuditRecord, signer: AuditReceiptKeyPair): SignedAuditReceipt {
  // Ed25519 is a fixed-digest algorithm: Node/OpenSSL requires a null digest.
  const signature = sign(null, Buffer.from(auditReceiptMessage(record)), signer.privateKey).toString('base64');
  return {
    version: AUDIT_RECEIPT_VERSION,
    recordId: record.recordId,
    hash: record.hash,
    signature,
    signerPublicKey: signer.publicKey,
    action: record.action,
    actor: record.actor,
    entityType: record.entityType,
    entityId: record.entityId,
  };
}

const failure = (reason: AuditReceiptFailureReason): AuditReceiptVerification => ({ ok: false, reason });

/**
 * Verifies a receipt against the entry it claims to cover. Checks binding
 * fields first (so a receipt cannot be replayed for a different entry), then
 * the signature, then — when supplied — the set of trusted signer keys.
 */
export function verifyAuditReceipt(
  record: AuditRecord,
  receipt: SignedAuditReceipt,
  options: { trustedPublicKeys?: readonly string[] } = {},
): AuditReceiptVerification {
  if (!receipt || receipt.version !== AUDIT_RECEIPT_VERSION) return failure('unsupported_version');
  if (
    !receipt.signature ||
    !receipt.signerPublicKey ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(receipt.signature)
  ) {
    return failure('malformed_receipt');
  }

  if (
    receipt.recordId !== record.recordId ||
    receipt.hash !== record.hash ||
    receipt.action !== record.action ||
    receipt.actor !== record.actor ||
    receipt.entityType !== record.entityType ||
    receipt.entityId !== record.entityId
  ) {
    return failure('record_mismatch');
  }

  if (options.trustedPublicKeys && !options.trustedPublicKeys.includes(receipt.signerPublicKey)) {
    return failure('untrusted_signer');
  }

  try {
    return verify(
      null,
      Buffer.from(auditReceiptMessage(record)),
      receipt.signerPublicKey,
      Buffer.from(receipt.signature, 'base64'),
    )
      ? { ok: true }
      : failure('signature_mismatch');
  } catch {
    return failure('malformed_receipt');
  }
}
