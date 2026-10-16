import { createHash, createHmac, randomUUID } from 'crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { stableStringify } from './audit.canonical';
import { AuditRecord } from './audit.interface';

/**
 * Privacy-preserving audit evidence bundles for support investigations (#351).
 *
 * A bundle carries an entity's audit chain with secrets and PII removed, but
 * keeps everything needed to reason about behaviour: record ids, sequence
 * numbers, timestamps, chain hashes, amounts, statuses and contract ids.
 *
 * - Secrets (seeds, tokens, passwords, keys) are dropped outright.
 * - PII and free text are replaced by an HMAC digest under a server-held
 *   pepper. Equal inputs give equal digests inside and across bundles, so an
 *   investigator can still correlate ("same wallet as ticket #123"), and anyone
 *   holding the pepper can confirm a candidate value, but the bundle alone
 *   cannot be brute-forced back to emails or wallet addresses.
 * - Entry hashes are copied verbatim. They were computed over the unredacted
 *   content, so a reader can check chain linkage and sequence continuity; full
 *   content re-hashing happened at export time and is pinned in
 *   `sourceVerification`.
 *
 * See docs/audit-evidence-bundles.md.
 */

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = 1;
export const MIN_PEPPER_LENGTH = 32;

export type RedactionRule = 'secret' | 'pii' | 'free-text' | 'account' | 'actor';

export interface RedactedValue {
  redacted: RedactionRule;
  /** HMAC-SHA256(pepper, canonical value). Absent for secrets: never confirmable. */
  digest?: string;
}

export interface EvidenceRecord extends Omit<AuditRecord, 'entityId' | 'actor' | 'reason' | 'before' | 'after'> {
  entityId: string | RedactedValue;
  actor: RedactedValue;
  reason: RedactedValue | null;
  before: Record<string, any> | null;
  after: Record<string, any> | null;
}

export interface EvidenceBundle {
  schemaVersion: number;
  bundleId: string;
  caseId: string;
  generatedAt: string;
  generatedBy: string;
  pepperId: string;
  subject: { entityType: string; entityId: string | RedactedValue };
  chainHead: string | null;
  sourceVerification: {
    ok: boolean;
    checkedEntries: number;
    failures: { failedIndex: number; reason: string }[];
  };
  records: EvidenceRecord[];
  /** Where and why values were removed. Paths only, never values. */
  redactions: { path: string; rule: RedactionRule }[];
  /** sha256 over the canonical bundle without this field. */
  digest: string;
}

export interface BuildEvidenceOptions {
  caseId: string;
  generatedBy: string;
  pepper: string;
  pepperId: string;
  sourceVerification: { ok: boolean; checkedEntries: number; failures: { failedIndex: number; reason: string }[] };
  now?: Date;
}

const SECRET_KEY = /(secret|password|passphrase|api[-_]?key|private[-_]?key|seed|mnemonic|credential|authorization|(access|refresh|auth|bearer|session|reset)[-_]?token|^token$)/i;
const PII_KEY = /(email|phone|mobile|first[-_]?name|last[-_]?name|full[-_]?name|legal[-_]?name|^name$|dob|birth|ssn|passport|national[-_]?id|tax[-_]?id|iban|account[-_]?number|street|postal|zip|document|selfie|ip[-_]?address)/i;
const FREE_TEXT_KEY = /^(reason|note|notes|comment|comments|description|message|memo)$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;

/** Byte-identical canonical form, so digests are stable across exports. */
const digestOf = (pepper: string, value: unknown) =>
  createHmac('sha256', pepper).update(stableStringify(value)).digest('hex');

export function bundleDigest(bundle: Omit<EvidenceBundle, 'digest'> | EvidenceBundle): string {
  const { digest: _ignored, ...body } = bundle as EvidenceBundle;
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

function scalarRule(value: unknown): RedactionRule | undefined {
  if (typeof value !== 'string') return undefined;
  if (StrKey.isValidEd25519SecretSeed(value) || JWT.test(value)) return 'secret';
  if (EMAIL.test(value)) return 'pii';
  if (StrKey.isValidEd25519PublicKey(value)) return 'account'; // wallet = person; contract ids (C…) stay
  return undefined;
}

class Redactor {
  readonly redactions: { path: string; rule: RedactionRule }[] = [];

  constructor(private readonly pepper: string) {}

  replace(path: string, rule: RedactionRule, value: unknown): RedactedValue {
    this.redactions.push({ path, rule });
    return rule === 'secret' ? { redacted: rule } : { redacted: rule, digest: digestOf(this.pepper, value) };
  }

  scalar(path: string, value: unknown): unknown {
    const rule = scalarRule(value);
    return rule ? this.replace(path, rule, value) : value;
  }

  walk(path: string, value: any): any {
    if (value === null || value === undefined) return value ?? null;
    if (Array.isArray(value)) return value.map((v, i) => this.walk(`${path}[${i}]`, v));
    if (typeof value !== 'object') return this.scalar(path, value);

    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      const child = `${path}.${key}`;
      if (SECRET_KEY.test(key)) out[key] = this.replace(child, 'secret', value[key]);
      else if (PII_KEY.test(key)) out[key] = this.replace(child, 'pii', value[key]);
      else if (FREE_TEXT_KEY.test(key) && typeof value[key] === 'string') out[key] = this.replace(child, 'free-text', value[key]);
      else out[key] = this.walk(child, value[key]);
    }
    return out;
  }
}

export function buildEvidenceBundle(
  entityType: string,
  entityId: string,
  history: AuditRecord[],
  opts: BuildEvidenceOptions,
): EvidenceBundle {
  if (!opts.pepper || opts.pepper.length < MIN_PEPPER_LENGTH) {
    throw new Error(`evidence pepper must be at least ${MIN_PEPPER_LENGTH} characters`);
  }
  if (!opts.caseId) throw new Error('caseId is required: every bundle is tied to an investigation');

  const r = new Redactor(opts.pepper);
  const records: EvidenceRecord[] = history.map((entry, i) => ({
    sequence: entry.sequence,
    recordId: entry.recordId,
    entityType: entry.entityType,
    entityId: r.scalar(`records[${i}].entityId`, entry.entityId) as string | RedactedValue,
    action: entry.action,
    actor: r.replace(`records[${i}].actor`, scalarRule(entry.actor) === 'secret' ? 'secret' : 'actor', entry.actor),
    reason: entry.reason ? r.replace(`records[${i}].reason`, 'free-text', entry.reason) : null,
    before: r.walk(`records[${i}].before`, entry.before),
    after: r.walk(`records[${i}].after`, entry.after),
    recordedAt: entry.recordedAt,
    previousHash: entry.previousHash,
    hash: entry.hash,
  }));

  const body: Omit<EvidenceBundle, 'digest'> = {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    bundleId: randomUUID(),
    caseId: opts.caseId,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    generatedBy: opts.generatedBy,
    pepperId: opts.pepperId,
    subject: { entityType, entityId: r.scalar('subject.entityId', entityId) as string | RedactedValue },
    chainHead: history.length ? history[history.length - 1].hash : null,
    sourceVerification: {
      ok: opts.sourceVerification.ok,
      checkedEntries: opts.sourceVerification.checkedEntries,
      failures: opts.sourceVerification.failures.map((f) => ({ failedIndex: f.failedIndex, reason: f.reason })),
    },
    records,
    redactions: r.redactions,
  };
  return { ...body, digest: bundleDigest(body) };
}

/**
 * Offline check a support engineer or auditor can run on a received bundle
 * without any secret material.
 */
export function verifyEvidenceBundle(bundle: EvidenceBundle): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (bundle.schemaVersion !== EVIDENCE_BUNDLE_SCHEMA_VERSION) {
    problems.push(`unsupported schemaVersion ${bundle.schemaVersion}`);
  }
  if (bundleDigest(bundle) !== bundle.digest) problems.push('bundle digest mismatch (modified after export)');
  if (!bundle.sourceVerification.ok) problems.push('source chain failed verification at export time');

  bundle.records.forEach((rec, i) => {
    const prev = bundle.records[i - 1];
    if (i === 0 && rec.sequence !== 1) problems.push(`records[0]: chain does not start at sequence 1`);
    if (prev && rec.sequence !== prev.sequence + 1) problems.push(`records[${i}]: sequence gap`);
    if (prev && rec.previousHash !== prev.hash) problems.push(`records[${i}]: previousHash does not link`);
    if (prev && rec.recordedAt < prev.recordedAt) problems.push(`records[${i}]: timestamp goes backwards`);
  });
  const last = bundle.records[bundle.records.length - 1];
  if ((last?.hash ?? null) !== bundle.chainHead) problems.push('chainHead does not match last record');

  return { ok: problems.length === 0, problems };
}

/** For pepper holders: does `candidate` match a redacted digest? */
export function matchesRedacted(pepper: string, redacted: RedactedValue, candidate: unknown): boolean {
  return redacted.digest !== undefined && redacted.digest === digestOf(pepper, candidate);
}
