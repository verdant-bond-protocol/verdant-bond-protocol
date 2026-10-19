import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EXIT, parseArgs, runCli } from './backfill-cli';
import { KycRecordNormalizeJob } from './jobs/kyc-record-normalize.job';

const B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('backfill CLI', () => {
  let kycDir: string;
  let stateDir: string;
  let out: string[];
  let err: string[];

  const run = (...argv: string[]) =>
    runCli([...argv, '--state-dir', stateDir], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      jobs: { 'kyc-record-normalize': () => new KycRecordNormalizeJob(kycDir) },
    });

  beforeEach(() => {
    kycDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-'));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
    fs.writeFileSync(
      path.join(kycDir, 'kyc-records.json'),
      JSON.stringify({ records: { [B]: { address: B, status: 'pending', createdAt: 1, updatedAt: 1 } }, audit: [], version: 1 }),
    );
    out = [];
    err = [];
  });
  afterEach(() => {
    fs.rmSync(kycDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('parses flags in both --name value and --name=value forms, defaulting to plan', () => {
    expect(parseArgs(['--job', 'x', '--limit=5', '--resume'])).toEqual({
      command: 'plan',
      flags: { job: 'x', limit: '5', resume: true },
    });
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['--job'])).toThrow(/needs a value/);
  });

  it('plan prints a dry-run diff and the digest to confirm', async () => {
    expect(await run('plan', '--job', 'kyc-record-normalize')).toBe(EXIT.OK);
    const text = out.join('\n');
    expect(text).toMatch(/DRY RUN — nothing written/);
    expect(text).toMatch(/source: <missing> → "system"/);
    expect(text).toMatch(/--confirm-plan [0-9a-f]{64}/);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it('apply, status and rollback round-trip with JSON output and a report file', async () => {
    const reportFile = path.join(stateDir, 'report.json');
    expect(await run('apply', '--job', 'kyc-record-normalize', '--json', '--out', reportFile)).toBe(EXIT.OK);
    const report = JSON.parse(out.join('\n'));
    expect(report.status).toBe('completed');
    expect(JSON.parse(fs.readFileSync(reportFile, 'utf8')).runId).toBe(report.runId);

    out = [];
    expect(await run('status', '--job', 'kyc-record-normalize')).toBe(EXIT.OK);
    expect(out.join('\n')).toMatch(new RegExp(`run ${report.runId}: completed`));

    out = [];
    expect(await run('rollback', '--job', 'kyc-record-normalize', '--run', report.runId)).toBe(EXIT.OK);
    expect(out.join('\n')).toMatch(/restored 1, conflicts 0/);
  });

  it('exits REFUSED with an operator message on unsafe or invalid input', async () => {
    expect(await run('apply', '--job', 'kyc-record-normalize', '--resume')).toBe(EXIT.REFUSED);
    expect(err.join('\n')).toMatch(/No unfinished run/);
    expect(await run('apply', '--job', 'unknown')).toBe(EXIT.REFUSED);
    expect(await run('apply', '--job', 'kyc-record-normalize', '--batch-size', '0')).toBe(EXIT.REFUSED);
    expect(await run('apply', '--job', 'kyc-record-normalize', '--confirm-plan', 'deadbeef')).toBe(EXIT.REFUSED);
    expect(await run('rollback', '--job', 'kyc-record-normalize')).toBe(EXIT.REFUSED);
  });

  it('exits INCOMPLETE when stopped early so automation does not treat it as done', async () => {
    expect(await run('apply', '--job', 'kyc-record-normalize', '--limit', '1')).toBe(EXIT.OK);
    expect(
      await runCli(['apply', '--job', 'kyc-record-normalize', '--state-dir', stateDir, '--restart'], {
        out: () => undefined,
        err: () => undefined,
        shouldStop: () => true,
        jobs: { 'kyc-record-normalize': () => new KycRecordNormalizeJob(kycDir) },
      }),
    ).toBe(EXIT.INCOMPLETE);
  });
});
