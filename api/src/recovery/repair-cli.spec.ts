import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { REPAIR_EXIT, parseRepairArgs, runRepairCli } from './repair-cli';
import { holderDedupeJob, RepairJobFactory } from './repair-jobs';
import { RepairJob } from './repair-tool.interface';

describe('Repair CLI', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let apply: jest.Mock;
  let jobs: Record<string, RepairJobFactory>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbs-repair-cli-'));
    out = [];
    err = [];
    apply = jest.fn(async () => undefined);
    const job: RepairJob = {
      id: 'demo:job',
      description: 'demo',
      steps: [{
        id: 'demo:step', description: 'fix it', inspect: () => false, apply, rollback: () => undefined,
      }],
    };
    jobs = { 'demo:job': () => job };
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const io = () => ({
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    jobs,
  });
  const base = (...extra: string[]) => [
    '--state-dir', dir, '--actor', 'operator', '--permissions', 'ops:read,ops:repair', ...extra,
  ];

  it('parseRepairArgs reads value and boolean flags', () => {
    expect(parseRepairArgs(['plan', '--job', 'j', '--json'])).toEqual({
      command: 'plan', flags: { job: 'j', json: true },
    });
    expect(() => parseRepairArgs(['plan', '--bogus'])).toThrow(/Unknown option/);
    expect(() => parseRepairArgs(['plan', '--job'])).toThrow(/needs a value/);
  });

  it('list prints the job catalogue', async () => {
    expect(await runRepairCli(['list', ...base()], io())).toBe(REPAIR_EXIT.OK);
    expect(out).toContain('demo:job');
  });

  it('plan is a dry run and prints a confirmable digest', async () => {
    const code = await runRepairCli(['plan', '--job', 'demo:job', ...base()], io());
    expect(code).toBe(REPAIR_EXIT.OK);
    expect(apply).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(out.join('\n')).toContain('DRY RUN');
    expect(out.join('\n')).toMatch(/plan digest: [0-9a-f]{16}/);
  });

  it('apply writes a checkpoint and status/resume can read it', async () => {
    expect(await runRepairCli(['apply', '--job', 'demo:job', ...base()], io())).toBe(REPAIR_EXIT.OK);
    expect(apply).toHaveBeenCalledTimes(1);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const runId = files[0].replace(/\.json$/, '');

    expect(await runRepairCli(['status', '--run', runId, ...base()], io())).toBe(REPAIR_EXIT.OK);
    expect(out.join('\n')).toContain('applied');
    expect(await runRepairCli(['resume', '--run', runId, '--job', 'demo:job', ...base()], io())).toBe(REPAIR_EXIT.OK);
    expect(apply).toHaveBeenCalledTimes(1); // already-applied step is not retried
  });

  it('refuses unauthorized writes with no side effects', async () => {
    const readOnly = { ...io(), jobs };
    const code = await runRepairCli([
      'apply', '--job', 'demo:job', '--state-dir', dir, '--actor', 'anon', '--permissions', 'ops:read',
    ], readOnly);
    expect(code).toBe(REPAIR_EXIT.REFUSED);
    expect(err.join('\n')).toContain('ops:repair');
    expect(apply).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('returns PARTIAL for failed steps and refuses a digest mismatch', async () => {
    apply.mockRejectedValueOnce(new Error('nope'));
    expect(await runRepairCli(['apply', '--job', 'demo:job', ...base()], io())).toBe(REPAIR_EXIT.PARTIAL);
    expect(err.join('\n')).toBe('');
    expect(await runRepairCli([
      'apply', '--job', 'demo:job', ...base('--confirm-plan', 'deadbeef'),
    ], io())).toBe(REPAIR_EXIT.REFUSED);
  });

  it('--json and --out emit machine-readable output', async () => {
    const target = path.join(dir, 'report.json');
    const code = await runRepairCli([
      'plan', '--job', 'demo:job', ...base('--json', '--out', target),
    ], io());
    expect(code).toBe(REPAIR_EXIT.OK);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(parsed).toMatchObject({ mode: 'dry-run', jobId: 'demo:job', status: 'completed' });
    expect(out[0]).toContain('"mode": "dry-run"');
  });

  it('the built-in holders:dedupe job is a real, reversible dry-run repair', async () => {
    const file = path.join(dir, 'holders.json');
    const before = {
      holders: [
        { address: 'G1', balance: '100' },
        { address: 'G1', balance: '250' },
        { address: 'G2', balance: '7' },
      ],
    };
    fs.writeFileSync(file, JSON.stringify(before));
    const builtinIo = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), jobs: { 'holders:dedupe': holderDedupeJob } };
    const fileFlags = ['--file', file];

    const planCode = await runRepairCli(
      ['plan', '--job', 'holders:dedupe', ...base(...fileFlags)], builtinIo,
    );
    expect(planCode).toBe(REPAIR_EXIT.OK);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(before); // no write in dry run

    const digest = /plan digest: ([0-9a-f]{16})/.exec(out.join('\n'))![1];
    expect(await runRepairCli([
      'apply', '--job', 'holders:dedupe', ...base(...fileFlags, '--confirm-plan', digest),
    ], builtinIo)).toBe(REPAIR_EXIT.OK);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).holders).toEqual([
      { address: 'G1', balance: '350' },
      { address: 'G2', balance: '7' },
    ]);

    const runId = fs.readdirSync(dir).find((f) => f.endsWith('.json') && f !== 'holders.json')!
      .replace(/\.json$/, '');
    expect(await runRepairCli([
      'rollback', '--run', runId, '--job', 'holders:dedupe', ...base(...fileFlags),
    ], builtinIo)).toBe(REPAIR_EXIT.OK);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(before);
  });
});
