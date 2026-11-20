import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Keypair } from '@stellar/stellar-sdk';
import { AuditService } from '../audit/audit.service';
import { KycService } from '../auth/kyc.service';
import { KycStoreService } from '../common/services/kyc-store.service';
import { RedisService } from '../common/services/redis.service';
import { KycStatus } from '../common/interfaces/authenticated-request.interface';
import { ImportBatch, QuarantineCode } from './import.interface';
import { ImportPipelineError, ImportPipelineService, MAX_ROW_ATTEMPTS, PREVIEW_TTL_MS } from './import-pipeline.service';
import { KycImportSink } from './kyc-import.sink';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const IN_ONE_YEAR = NOW + 365 * 24 * 60 * 60 * 1000;
const ADMIN = Keypair.random().publicKey();

function address(): string {
  return Keypair.random().publicKey();
}

function fakeRedis(): RedisService {
  const data = new Map<string, string>();
  return {
    get: jest.fn(async (k: string) => data.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      data.set(k, v);
    }),
    del: jest.fn(async (k: string) => {
      data.delete(k);
    }),
  } as unknown as RedisService;
}

async function expectPipelineError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ImportPipelineError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('ImportPipelineService (KYC attestations)', () => {
  let dir: string;
  let store: KycStoreService;
  let kyc: KycService;
  let sink: KycImportSink;
  let audit: AuditService;
  let pipeline: ImportPipelineService;
  let clock: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-pipeline-'));
    process.env.KYC_STORE_DIR = dir;
    delete process.env.IMPORT_PIPELINE;
    store = new KycStoreService();
    await store.onModuleInit();
    kyc = new KycService(fakeRedis(), store);
    sink = new KycImportSink(kyc, store);
    audit = new AuditService();
    pipeline = new ImportPipelineService(sink, audit);
    clock = NOW;
    sink.now = () => clock;
    pipeline.now = () => clock;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.KYC_STORE_DIR;
    delete process.env.IMPORT_PIPELINE;
  });

  const row = (addr: string, overrides: Record<string, unknown> = {}) => ({
    address: addr,
    status: 'verified',
    providerReference: `prov-${addr.slice(0, 8)}`,
    expiresAt: new Date(IN_ONE_YEAR).toISOString(),
    ...overrides,
  });

  const preview = (rows: unknown[]) => pipeline.preview({ kind: 'kyc_attestation', format: 'json', rows, actor: ADMIN });
  const commit = (batch: ImportBatch, extra: { allowDuplicate?: boolean } = {}) =>
    pipeline.commit(batch.id, { previewHash: batch.previewHash, actor: ADMIN, ...extra });
  const rollback = (batch: ImportBatch) => pipeline.rollback(batch.id, { previewHash: batch.previewHash, actor: ADMIN });

  describe('preview', () => {
    it('classifies rows and does not write to the KYC store', async () => {
      const good = address();
      const batch = await preview([
        row(good),
        row('not-an-address'),
        row(address(), { status: 'verified', expiresAt: null }),
        row(address(), { providerReference: '=HYPERLINK("x")' }),
        row(address(), { status: 'superuser' }),
        row(address(), { expiresAt: new Date(NOW - 1000).toISOString() }),
        row(address(), { expiresAt: '2027-01-01' }),
        row(address(), { status: 'rejected' }),
        'not an object',
      ]);

      expect(batch.status).toBe('previewed');
      expect(batch.summary).toMatchObject({ total: 9, accepted: 1, quarantined: 8, create: 1 });
      const byLine = (line: number) => batch.rows.find((r) => r.line === line)!;
      expect(byLine(1)).toMatchObject({ verdict: 'accepted', action: 'create', key: good, before: null });
      expect(byLine(2).reasons[0].code).toBe(QuarantineCode.INVALID_ADDRESS);
      expect(byLine(3).reasons[0]).toMatchObject({ code: QuarantineCode.MISSING_FIELD, field: 'expiresAt' });
      expect(byLine(4).reasons[0].code).toBe(QuarantineCode.FORMULA_INJECTION);
      expect(byLine(5).reasons[0]).toMatchObject({ code: QuarantineCode.INVALID_VALUE, field: 'status' });
      expect(byLine(6).reasons[0].message).toMatch(/past/);
      expect(byLine(7).reasons[0].message).toMatch(/timezone/);
      expect(byLine(8).reasons[0].message).toMatch(/only applies/);
      expect(byLine(9).reasons[0].code).toBe(QuarantineCode.MALFORMED_ROW);
      // Quarantined rows keep their raw input so the operator can fix them.
      expect(byLine(2).raw).toMatchObject({ address: 'not-an-address' });
      expect(byLine(1).raw).toBeUndefined();

      expect(await store.list()).toEqual([]);
      expect(await store.listAudit(undefined, 10_000)).toEqual([]);
    });

    it('accepts CSV and records the source digest', async () => {
      const a = address();
      const csv = `address,status,providerReference,expiresAt,reason\n${a},verified,prov-1,${IN_ONE_YEAR},"passed, re-check"\n`;
      const batch = await pipeline.preview({ kind: 'kyc_attestation', format: 'csv', csv, sourceName: 'provider.csv', actor: ADMIN });
      expect(batch.rows[0]).toMatchObject({ line: 2, verdict: 'accepted', key: a });
      expect(batch.rows[0].normalized).toMatchObject({ expiresAt: IN_ONE_YEAR, reason: 'passed, re-check' });
      expect(batch.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(batch.sourceName).toBe('provider.csv');
    });

    it('refuses payload-level problems outright', async () => {
      await expectPipelineError(pipeline.preview({ kind: 'bond_holder', format: 'json', rows: [], actor: ADMIN }), 'INVALID_REQUEST');
      await expectPipelineError(pipeline.preview({ kind: 'kyc_attestation', format: 'json', rows: {}, actor: ADMIN }), 'INVALID_REQUEST');
      await expectPipelineError(pipeline.preview({ kind: 'kyc_attestation', format: 'csv', csv: 'a,a\n1,2', actor: ADMIN }), 'INVALID_REQUEST');
    });

    it('quarantines every row that shares a key within the batch', async () => {
      const a = address();
      const batch = await preview([row(a), row(a, { status: 'rejected', expiresAt: null }), row(address())]);
      expect(batch.rows.map((r) => r.verdict)).toEqual(['quarantined', 'quarantined', 'accepted']);
      expect(batch.rows[0].reasons[0].code).toBe(QuarantineCode.DUPLICATE_IN_BATCH);
    });

    it('detects noop rows and refuses to lift a rejection', async () => {
      const same = address();
      const rejected = address();
      await kyc.transitionStatus(same, KycStatus.VERIFIED, { expiresAt: IN_ONE_YEAR });
      await kyc.transitionStatus(rejected, KycStatus.REJECTED, {});

      const batch = await preview([row(same, { expiresAt: IN_ONE_YEAR }), row(rejected)]);
      expect(batch.rows[0]).toMatchObject({ verdict: 'accepted', action: 'noop' });
      expect(batch.rows[1]).toMatchObject({ verdict: 'quarantined' });
      expect(batch.rows[1].reasons[0].code).toBe(QuarantineCode.REQUIRES_REVIEW);
    });
  });

  describe('commit', () => {
    it('applies only accepted rows and leaves a trace in the batch, KYC audit log and audit chain', async () => {
      const a = address();
      const batch = await preview([row(a), row('bad')]);
      const done = await commit(batch);

      expect(done.status).toBe('committed');
      expect(done.summary.applied).toBe(1);
      expect((await store.get(a))!.status).toBe(KycStatus.VERIFIED);
      expect((await store.get(a))!.source).toBe('import');

      expect(done.trace).toEqual([
        expect.objectContaining({ batchId: batch.id, rowIndex: 0, line: 1, key: a, action: 'create', before: null, actor: ADMIN }),
      ]);
      expect(done.trace[0].fingerprint).toBe(batch.rows[0].fingerprint);
      expect(pipeline.traceForKey(a)).toHaveLength(1);

      const [kycEntry] = await store.listAudit(a, 10_000);
      expect(kycEntry.source).toBe('import');
      expect(kycEntry.reason).toContain(`import ${batch.id} row 0 sha256:${batch.rows[0].fingerprint.slice(0, 16)}`);

      const history = audit.getEntityHistory('import_batch', batch.id).map((e) => e.action);
      expect(history).toEqual(['import.previewed', 'import.committed']);
      expect((await audit.verifyEntity('import_batch', batch.id)).ok).toBe(true);
    });

    it('requires the previewHash that was reviewed', async () => {
      const batch = await preview([row(address())]);
      await expectPipelineError(pipeline.commit(batch.id, { previewHash: 'x'.repeat(64), actor: ADMIN }), 'PREVIEW_MISMATCH');
      const other = await preview([row(address())]);
      await expectPipelineError(pipeline.commit(batch.id, { previewHash: other.previewHash, actor: ADMIN }), 'PREVIEW_MISMATCH');
      expect(await store.list()).toEqual([]);
    });

    it('rejects a commit after the preview expires', async () => {
      const batch = await preview([row(address())]);
      clock += PREVIEW_TTL_MS + 1;
      await expectPipelineError(commit(batch), 'PREVIEW_EXPIRED');
      expect(pipeline.get(batch.id).status).toBe('expired');
    });

    it('refuses a second commit, including a concurrent one', async () => {
      const batch = await preview([row(address()), row(address())]);
      const first = commit(batch);
      await expectPipelineError(commit(batch), 'INVALID_STATE');
      await expectPipelineError(rollback(batch), 'INVALID_STATE');
      expect((await first).status).toBe('committed');
      await expectPipelineError(commit(batch), 'INVALID_STATE');
    });

    it('blocks re-importing identical content unless explicitly allowed', async () => {
      const rows = [row(address())];
      await commit(await preview(rows));
      const again = await preview(rows);
      expect(again.duplicateOf).not.toBeNull();
      await expectPipelineError(commit(again), 'DUPLICATE_IMPORT');
      // All rows are noop now, so allowing it changes nothing.
      const forced = await commit(again, { allowDuplicate: true });
      expect(forced.status).toBe('committed');
      expect(forced.trace).toEqual([]);
    });

    it('honours the IMPORT_PIPELINE=off kill switch for commits only', async () => {
      const batch = await preview([row(address())]);
      process.env.IMPORT_PIPELINE = 'off';
      await expectPipelineError(commit(batch), 'DISABLED');
      expect(await store.list()).toEqual([]);
    });

    it('quarantines rows whose target changed after preview instead of overwriting them', async () => {
      const a = address();
      const b = address();
      const batch = await preview([row(a), row(b)]);
      await kyc.transitionStatus(a, KycStatus.REJECTED, { reason: 'sanctions hit' });

      const done = await commit(batch);
      expect(done.status).toBe('committed');
      expect(done.rows[0].verdict).toBe('quarantined');
      expect(done.rows[0].reasons.map((r) => r.code)).toContain(QuarantineCode.STATE_DRIFT);
      expect((await store.get(a))!.status).toBe(KycStatus.REJECTED);
      expect((await store.get(b))!.status).toBe(KycStatus.VERIFIED);
    });
  });

  describe('retry', () => {
    it('stops at a failing row and resumes after it without re-applying earlier rows', async () => {
      const addrs = [address(), address(), address()];
      const batch = await preview(addrs.map((a) => row(a)));
      const apply = jest.spyOn(sink, 'apply');
      apply.mockImplementationOnce(KycImportSink.prototype.apply.bind(sink)).mockRejectedValueOnce(new Error('disk full'));

      const partial = await commit(batch);
      expect(partial.status).toBe('partially_committed');
      expect(partial.trace.map((t) => t.rowIndex)).toEqual([0]);
      expect(partial.lastError).toMatchObject({ rowIndex: 1, message: 'disk full' });
      expect(partial.attempts).toEqual({ 1: 1 });
      expect(await store.get(addrs[2])).toBeNull();

      apply.mockRestore();
      const resumed = await commit(batch);
      expect(resumed.status).toBe('committed');
      expect(resumed.trace.map((t) => t.rowIndex)).toEqual([0, 1, 2]);
      expect(resumed.lastError).toBeNull();
      expect(await store.listAudit(addrs[0], 10_000)).toHaveLength(1);
      expect(audit.getEntityHistory('import_batch', batch.id).map((e) => e.action)).toEqual([
        'import.previewed',
        'import.partially_committed',
        'import.committed',
      ]);
    });

    it('traces a write that reached the store even though apply then threw', async () => {
      const a = address();
      const batch = await preview([row(a)]);
      jest.spyOn(sink, 'apply').mockImplementationOnce(async (r, ctx) => {
        await KycImportSink.prototype.apply.call(sink, r, ctx);
        throw new Error('redis timeout after write');
      });

      expect((await commit(batch)).status).toBe('partially_committed');
      const resumed = await commit(batch);
      expect(resumed.status).toBe('committed');
      expect(resumed.trace).toHaveLength(1);
      expect(await store.listAudit(a, 10_000)).toHaveLength(1);
    });

    it(`quarantines a row as APPLY_FAILED after ${MAX_ROW_ATTEMPTS} failed attempts`, async () => {
      const [a, b] = [address(), address()];
      const batch = await preview([row(a), row(b)]);
      const apply = jest.spyOn(sink, 'apply').mockImplementation(async (r, ctx) => {
        if (r.address === a) throw new Error('provider record locked');
        return KycImportSink.prototype.apply.call(sink, r, ctx);
      });

      for (let i = 0; i < MAX_ROW_ATTEMPTS; i++) {
        expect((await commit(batch)).status).toBe('partially_committed');
      }
      const done = await commit(batch);
      apply.mockRestore();

      expect(done.status).toBe('committed');
      expect(done.rows[0].reasons.map((r) => r.code)).toContain(QuarantineCode.APPLY_FAILED);
      expect(done.trace.map((t) => t.key)).toEqual([b]);
    });
  });

  describe('rollback', () => {
    it('restores pre-import state newest-first; created records fall back to none', async () => {
      const fresh = address();
      const existing = address();
      await kyc.transitionStatus(existing, KycStatus.VERIFIED, { expiresAt: IN_ONE_YEAR });
      const batch = await preview([row(fresh), row(existing, { status: 'rejected', expiresAt: null })]);
      await commit(batch);
      expect((await store.get(existing))!.status).toBe(KycStatus.REJECTED);

      const undone = await rollback(batch);
      expect(undone.status).toBe('rolled_back');
      expect(undone.rollbackConflicts).toEqual([]);
      expect(undone.summary).toMatchObject({ applied: 0, rolledBack: 2 });
      expect(await store.get(existing)).toMatchObject({ status: KycStatus.VERIFIED, expiresAt: IN_ONE_YEAR });
      expect((await store.get(fresh))!.status).toBe(KycStatus.NONE);
      expect((await kyc.isEligibleRecord(fresh, KycStatus.VERIFIED)).eligible).toBe(false);

      const reasons = (await store.listAudit(existing, 10_000)).map((e) => e.reason);
      expect(reasons[reasons.length - 1]).toBe(`rollback of import ${batch.id} row 1`);
      await expectPipelineError(rollback(batch), 'INVALID_STATE');
    });

    it('leaves records changed after the import alone and resumes once resolved', async () => {
      const [a, b] = [address(), address()];
      const batch = await preview([row(a), row(b)]);
      await commit(batch);
      await kyc.transitionStatus(a, KycStatus.REJECTED, { reason: 'manual review' });

      const blocked = await rollback(batch);
      expect(blocked.status).toBe('rollback_incomplete');
      expect(blocked.rollbackConflicts).toEqual([expect.objectContaining({ kind: 'conflict', rowIndex: 0, key: a })]);
      expect((await store.get(a))!.status).toBe(KycStatus.REJECTED);
      expect((await store.get(b))!.status).toBe(KycStatus.NONE);

      // Operator decides the later manual change should also be undone.
      await kyc.transitionStatus(a, KycStatus.VERIFIED, { expiresAt: IN_ONE_YEAR });
      const resolved = await rollback(batch);
      expect(resolved.status).toBe('rolled_back');
      expect(resolved.rollbackConflicts).toEqual([]);
      expect((await store.get(a))!.status).toBe(KycStatus.NONE);
    });

    it('reports a residual difference the store cannot undo without blocking', async () => {
      const a = address();
      await kyc.transitionStatus(a, KycStatus.PENDING, {});
      const batch = await preview([row(a)]);
      await commit(batch);

      const undone = await rollback(batch);
      expect(undone.status).toBe('rolled_back');
      expect((await store.get(a))!.status).toBe(KycStatus.PENDING);
      expect(undone.rollbackConflicts).toEqual([expect.objectContaining({ kind: 'residual', key: a })]);
    });

    it('rolls back the applied part of a partially committed batch', async () => {
      const [a, b] = [address(), address()];
      const batch = await preview([row(a), row(b)]);
      jest.spyOn(sink, 'apply')
        .mockImplementationOnce(KycImportSink.prototype.apply.bind(sink))
        .mockRejectedValueOnce(new Error('boom'));
      await commit(batch);

      const undone = await rollback(batch);
      expect(undone.status).toBe('rolled_back');
      expect((await store.get(a))!.status).toBe(KycStatus.NONE);
      expect(await store.get(b)).toBeNull();
    });

    it('stays available while the kill switch is on', async () => {
      const batch = await preview([row(address())]);
      await commit(batch);
      process.env.IMPORT_PIPELINE = 'off';
      expect((await rollback(batch)).status).toBe('rolled_back');
    });

    it('allows re-importing content once its batch was rolled back', async () => {
      const rows = [row(address())];
      const first = await preview(rows);
      await commit(first);
      await rollback(first);
      const again = await preview(rows);
      expect(again.duplicateOf).toBeNull();
      // The `none` record the rollback left reads as absent, so this is a create again.
      expect(again.rows[0]).toMatchObject({ action: 'create', before: null });
      expect((await commit(again)).status).toBe('committed');
      expect((await store.get(rows[0].address))!.status).toBe(KycStatus.VERIFIED);
    });
  });

  describe('discard and reads', () => {
    it('discards a preview, which can then no longer be committed', async () => {
      const batch = await preview([row(address())]);
      expect((await pipeline.discard(batch.id, ADMIN)).status).toBe('discarded');
      await expectPipelineError(commit(batch), 'INVALID_STATE');
    });

    it('returns snapshots that cannot mutate internal state', async () => {
      const batch = await preview([row('bad')]);
      batch.rows[0].verdict = 'accepted';
      expect(pipeline.quarantined(batch.id)).toHaveLength(1);
      expect(pipeline.list()[0]).not.toHaveProperty('rows');
      await expectPipelineError(Promise.resolve().then(() => pipeline.get('missing')), 'NOT_FOUND');
    });
  });
});
