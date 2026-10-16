import { Keypair } from '@stellar/stellar-sdk';
import { AuditService } from './audit.service';
import {
  buildEvidenceBundle,
  bundleDigest,
  matchesRedacted,
  verifyEvidenceBundle,
  EvidenceBundle,
  RedactedValue,
} from './evidence-bundle';

const PEPPER = 'p'.repeat(48);
const INVESTOR = Keypair.random();
const BOND_CONTRACT = 'CBBE6TSEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHW4';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

async function seededHistory(audit: AuditService) {
  await audit.record({
    entityType: 'kyc',
    entityId: 'inv-42',
    action: 'submitted',
    actor: INVESTOR.publicKey(),
    reason: 'Jane Doe uploaded passport, call +44 20 7946 0000',
    before: null,
    after: {
      status: 'pending',
      email: 'jane@example.com',
      legalName: 'Jane Doe',
      passportNumber: 'X1234567',
      wallet: INVESTOR.publicKey(),
      kycStatus: 'pending',
    },
  });
  await audit.record({
    entityType: 'kyc',
    entityId: 'inv-42',
    action: 'approved',
    actor: 'compliance-officer-7',
    before: { status: 'pending' },
    after: {
      status: 'approved',
      bondContract: BOND_CONTRACT,
      allocation: { amount: '1500.0000000', couponRateBps: 450 },
      session: { accessToken: JWT, signerSeed: INVESTOR.secret() },
      notes: 'phoned investor at home',
    },
  });
  return audit.getEntityHistory('kyc', 'inv-42');
}

function build(history: any[], sourceOk = true): EvidenceBundle {
  return buildEvidenceBundle('kyc', 'inv-42', history, {
    caseId: 'SUP-1001',
    generatedBy: 'support-admin',
    pepper: PEPPER,
    pepperId: 'v1',
    sourceVerification: { ok: sourceOk, checkedEntries: history.length, failures: [] },
    now: new Date('2026-10-01T00:00:00.000Z'),
  });
}

describe('evidence bundles (#351)', () => {
  let audit: AuditService;
  let history: any[];

  beforeEach(async () => {
    audit = new AuditService();
    history = await seededHistory(audit);
  });

  it('removes every secret and PII value from the serialised bundle', () => {
    const json = JSON.stringify(build(history));
    for (const leaked of [
      'jane@example.com',
      'Jane Doe',
      'X1234567',
      '+44 20 7946 0000',
      INVESTOR.publicKey(),
      INVESTOR.secret(),
      JWT,
      'phoned investor at home',
    ]) {
      expect(json).not.toContain(leaked);
    }
  });

  it('preserves ids, hashes, timestamps, amounts, statuses and contract ids', () => {
    const bundle = build(history);
    expect(bundle.records.map((r) => [r.recordId, r.hash, r.previousHash, r.recordedAt, r.sequence])).toEqual(
      history.map((h) => [h.recordId, h.hash, h.previousHash, h.recordedAt, h.sequence]),
    );
    const approved = bundle.records[1].after!;
    expect(approved.status).toBe('approved');
    expect(approved.bondContract).toBe(BOND_CONTRACT);
    expect(approved.allocation).toEqual({ amount: '1500.0000000', couponRateBps: 450 });
    expect(bundle.records[0].after!.kycStatus).toBe('pending');
    expect(bundle.chainHead).toBe(audit.getChainHead('kyc', 'inv-42'));
  });

  it('drops secrets without a digest, so they can never be confirmed', () => {
    const session = build(history).records[1].after!.session;
    expect(session.accessToken).toEqual({ redacted: 'secret' });
    expect(session.signerSeed).toEqual({ redacted: 'secret' });
  });

  it('keeps PII correlatable and confirmable only with the pepper', () => {
    const bundle = build(history);
    const actor = bundle.records[0].actor;
    const wallet = bundle.records[0].after!.wallet as RedactedValue;
    expect(actor.digest).toBe(wallet.digest); // same person across fields
    expect(matchesRedacted(PEPPER, wallet, INVESTOR.publicKey())).toBe(true);
    expect(matchesRedacted('q'.repeat(48), wallet, INVESTOR.publicKey())).toBe(false);
    expect(matchesRedacted(PEPPER, bundle.records[0].after!.email, 'other@example.com')).toBe(false);
  });

  it('lists redacted paths without their values', () => {
    const { redactions } = build(history);
    expect(redactions).toEqual(
      expect.arrayContaining([
        { path: 'records[0].after.email', rule: 'pii' },
        { path: 'records[0].after.wallet', rule: 'account' },
        { path: 'records[1].after.session.signerSeed', rule: 'secret' },
        { path: 'records[1].after.notes', rule: 'free-text' },
      ]),
    );
  });

  it('is deterministic apart from the bundle id', () => {
    const a = build(history);
    const b = build(history);
    expect({ ...a, bundleId: '', digest: '' }).toEqual({ ...b, bundleId: '', digest: '' });
  });

  it('verifies a pristine bundle offline', () => {
    expect(verifyEvidenceBundle(build(history))).toEqual({ ok: true, problems: [] });
  });

  it.each([
    ['edited value', (b: EvidenceBundle) => { b.records[1].after!.status = 'rejected'; }, 'bundle digest mismatch'],
    ['dropped record', (b: EvidenceBundle) => { b.records.shift(); b.digest = bundleDigest(b); }, 'sequence 1'],
    ['relinked hash', (b: EvidenceBundle) => { b.records[1].previousHash = 'f'.repeat(64); b.digest = bundleDigest(b); }, 'previousHash'],
    ['swapped head', (b: EvidenceBundle) => { b.chainHead = 'e'.repeat(64); b.digest = bundleDigest(b); }, 'chainHead'],
  ])('detects tampering: %s', (_label, tamper, expected) => {
    const bundle = build(history);
    tamper(bundle);
    const result = verifyEvidenceBundle(bundle);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain(expected);
  });

  it('flags a bundle exported from a chain that failed verification', () => {
    expect(verifyEvidenceBundle(build(history, false)).problems).toContain(
      'source chain failed verification at export time',
    );
  });

  it('refuses a weak pepper and a missing case id', () => {
    expect(() => buildEvidenceBundle('kyc', 'inv-42', history, {
      caseId: 'SUP-1', generatedBy: 'a', pepper: 'short', pepperId: 'v1',
      sourceVerification: { ok: true, checkedEntries: 0, failures: [] },
    })).toThrow(/pepper/);
    expect(() => buildEvidenceBundle('kyc', 'inv-42', history, {
      caseId: '', generatedBy: 'a', pepper: PEPPER, pepperId: 'v1',
      sourceVerification: { ok: true, checkedEntries: 0, failures: [] },
    })).toThrow(/caseId/);
  });

  describe('AuditService.exportEvidenceBundle', () => {
    afterEach(() => delete process.env.AUDIT_EVIDENCE_PEPPER);

    it('is unavailable until a pepper is configured', async () => {
      await expect(audit.exportEvidenceBundle('kyc', 'inv-42', 'SUP-1', 'admin')).rejects.toThrow(/not configured/);
    });

    it('exports a verifiable bundle and audits the export itself', async () => {
      process.env.AUDIT_EVIDENCE_PEPPER = PEPPER;
      const bundle = await audit.exportEvidenceBundle('kyc', 'inv-42', 'SUP-1', 'admin');

      expect(verifyEvidenceBundle(bundle).ok).toBe(true);
      const trail = audit.getEntityHistory('evidence-bundle', 'SUP-1');
      expect(trail).toHaveLength(1);
      expect(trail[0].after).toMatchObject({ bundleId: bundle.bundleId, digest: bundle.digest });
    });

    it('carries a source-chain failure into the bundle', async () => {
      process.env.AUDIT_EVIDENCE_PEPPER = PEPPER;
      audit.removeEntryAt('kyc', 'inv-42', 0);
      const bundle = await audit.exportEvidenceBundle('kyc', 'inv-42', 'SUP-2', 'admin');
      expect(bundle.sourceVerification.ok).toBe(false);
      expect(verifyEvidenceBundle(bundle).ok).toBe(false);
    });
  });
});
