import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackfillRunner } from '../backfill-runner';
import { BackfillStateStore } from '../backfill-state.store';
import { KycRecordNormalizeJob } from './kyc-record-normalize.job';

const A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const D = 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

const complete = {
  address: A,
  status: 'verified',
  source: 'provider',
  actor: null,
  reason: null,
  providerReference: 'ref-1',
  createdAt: 1700000000000,
  updatedAt: 1700000000500,
  expiresAt: null,
};

describe('KycRecordNormalizeJob', () => {
  let kycDir: string;
  let stateDir: string;
  let file: string;
  let runner: BackfillRunner;

  const write = (records: Record<string, unknown>) =>
    fs.writeFileSync(file, JSON.stringify({ records, audit: [], version: 1 }, null, 2));
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

  beforeEach(() => {
    kycDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-'));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
    file = path.join(kycDir, 'kyc-records.json');
    runner = new BackfillRunner(new BackfillStateStore(stateDir));
  });
  afterEach(() => {
    fs.rmSync(kycDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('plans field-level changes for legacy records and leaves complete ones alone', () => {
    const job = new KycRecordNormalizeJob(kycDir);
    expect(job.plan(A, { ...complete })).toEqual({ action: 'noop' });

    const decision = job.plan(B, {
      address: B,
      status: 'pending',
      createdAt: '2023-11-14T22:13:20.000Z',
      expiresAt: '1700000000000',
      legacyFlag: true,
    });
    expect(decision).toEqual({
      action: 'update',
      after: {
        address: B,
        status: 'pending',
        createdAt: 1700000000000,
        expiresAt: 1700000000000,
        legacyFlag: true,
        source: 'system',
        actor: null,
        reason: null,
        providerReference: null,
        updatedAt: 1700000000000,
      },
      changes: [
        'source: <missing> → "system"',
        'actor: <missing> → null',
        'reason: <missing> → null',
        'providerReference: <missing> → null',
        'expiresAt: "1700000000000" → 1700000000000',
        'createdAt: "2023-11-14T22:13:20.000Z" → 1700000000000',
        'updatedAt: <missing> → 1700000000000',
      ],
    });
  });

  it('skips records it cannot safely infer and fails ones that break the schema', () => {
    const job = new KycRecordNormalizeJob(kycDir);
    expect(job.plan('bad', { ...complete, address: 'bad' })).toMatchObject({ action: 'skip' });
    expect(job.plan(B, { ...complete })).toMatchObject({ action: 'skip', reason: expect.stringMatching(/does not match its key/) });
    expect(job.plan(A, { address: A, status: 'pending' })).toMatchObject({ action: 'skip', reason: expect.stringMatching(/createdAt/) });
    expect(() => job.plan(A, { ...complete, status: 'approved' })).toThrow(/unknown status/);
    expect(() => job.plan(A, { ...complete, source: 'oracle' })).toThrow(/unknown source/);
    expect(() => job.plan(A, { ...complete, expiresAt: 'soon' })).toThrow(/expiresAt is not a timestamp/);
  });

  it('end to end: dry-run, apply, idempotent re-run and rollback against the file', async () => {
    const original = {
      [A]: { ...complete },
      [B]: { address: B, status: 'pending', createdAt: 1, updatedAt: 2 },
      [C]: { address: C, status: 'mystery', createdAt: 1, updatedAt: 1 },
      [D]: { address: D, status: 'verified', source: 'admin', createdAt: 5 },
    };
    write(original);
    const rawBefore = fs.readFileSync(file, 'utf8');

    const preview = await runner.preview(new KycRecordNormalizeJob(kycDir));
    expect(fs.readFileSync(file, 'utf8')).toBe(rawBefore);
    expect(preview.counters).toEqual({ scanned: 4, updated: 2, unchanged: 1, skipped: 0, failed: 1 });
    expect(preview.failed[0]).toMatchObject({ key: C });

    const applied = await runner.apply(new KycRecordNormalizeJob(kycDir), { batchSize: 1, confirmPlan: preview.planDigest });
    expect(applied.status).toBe('completed');
    const after = read();
    expect(after.records[B]).toMatchObject({ source: 'system', actor: null, expiresAt: null });
    expect(after.records[D]).toMatchObject({ updatedAt: 5, source: 'admin' });
    expect(after.records[C]).toEqual(original[C]);
    expect(after.audit).toEqual([]);
    expect(after.version).toBe(1);

    const again = await runner.preview(new KycRecordNormalizeJob(kycDir));
    expect(again.counters.updated).toBe(0);

    const restored = await runner.rollback(new KycRecordNormalizeJob(kycDir), applied.runId!);
    expect(restored.conflicts).toEqual([]);
    expect(read().records).toEqual(original);
  });

  it('refuses to commit when the file changes under it (API still running)', async () => {
    write({ [B]: { address: B, status: 'pending', createdAt: 1, updatedAt: 1 } });
    const job = new KycRecordNormalizeJob(kycDir);
    await job.open();
    write({ [B]: { address: B, status: 'verified', createdAt: 1, updatedAt: 9 } });

    const decision = job.plan(B, (await job.load(B))!);
    if (decision.action !== 'update') throw new Error('expected update');
    await expect(job.commit([{ key: B, before: (await job.load(B))!, after: decision.after }])).rejects.toThrow(
      /changed on disk/,
    );
    expect(read().records[B].status).toBe('verified');
  });

  it('refuses to run against a missing or corrupt store', async () => {
    await expect(runner.preview(new KycRecordNormalizeJob(kycDir))).rejects.toThrow(/does not exist/);
    fs.writeFileSync(file, '{"records":');
    await expect(runner.preview(new KycRecordNormalizeJob(kycDir))).rejects.toThrow(/not valid JSON/);
  });
});
