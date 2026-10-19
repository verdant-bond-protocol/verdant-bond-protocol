import * as fs from 'fs';
import {
  BackfillCheckpoint,
  BackfillJob,
  BackfillRefusedError,
  BackfillReport,
  BackfillRestoreResult,
} from './backfill.interface';
import { BackfillRunner } from './backfill-runner';
import { BackfillStateStore } from './backfill-state.store';
import { BACKFILL_JOBS } from './jobs';

export const EXIT = {
  OK: 0,
  ERROR: 1,
  REFUSED: 2,
  /** Run finished but some records failed or rollback hit conflicts. */
  PARTIAL: 3,
  /** Run stopped early (signal, limit, failure threshold, commit error). */
  INCOMPLETE: 4,
} as const;

export const USAGE = `Usage: npm run backfill -- <command> --job <id> [options]

Commands:
  list                       List registered jobs
  plan                       Dry-run: print the diff, write nothing (default)
  apply                      Apply in batches with checkpoints and a journal
  status                     Show the job's last checkpoint
  rollback --run <runId>     Restore before-images from a run's journal

Options:
  --batch-size <n>           Records per committed batch (default 50)
  --limit <n>                Process at most n records, then stop (canary)
  --max-failures <n>         Abort once n records have failed (default 25)
  --resume                   Continue an interrupted/aborted run
  --restart                  Discard an unfinished checkpoint and start over
  --retry-failed             Reprocess only the last run's failed records
  --confirm-plan <digest>    Refuse to apply unless the plan digest matches
  --force-unlock             Take over a lock left by a dead process
  --out <file>               Also write the full JSON report to a file
  --json                     Print the JSON report instead of a summary
  --state-dir <dir>          Checkpoint/journal dir (default $BACKFILL_STATE_DIR or data/backfill)
`;

const VALUE_FLAGS = new Set(['job', 'batch-size', 'limit', 'max-failures', 'confirm-plan', 'run', 'out', 'state-dir']);
const BOOL_FLAGS = new Set(['resume', 'restart', 'retry-failed', 'force-unlock', 'json', 'help']);

export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (command) throw new BackfillRefusedError(`Unexpected argument ${arg}`);
      command = arg;
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (BOOL_FLAGS.has(name)) {
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new BackfillRefusedError(`--${name} needs a value`);
      }
      flags[name] = value;
    } else {
      throw new BackfillRefusedError(`Unknown option --${name}`);
    }
  }
  return { command: command ?? 'plan', flags };
}

function intFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new BackfillRefusedError(`--${name} must be a positive integer`);
  return n;
}

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  shouldStop?: () => boolean;
  jobs?: Record<string, () => BackfillJob<any>>;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    const { command, flags } = parseArgs(argv);
    const jobs = io.jobs ?? BACKFILL_JOBS;
    if (flags.help) {
      io.out(USAGE);
      return EXIT.OK;
    }
    if (command === 'list') {
      for (const [id, make] of Object.entries(jobs)) {
        const job = make();
        io.out(`${id}@${job.version}  ${job.description}`);
      }
      return EXIT.OK;
    }

    const jobId = flags.job;
    if (typeof jobId !== 'string') throw new BackfillRefusedError('--job is required');
    if (!jobs[jobId]) throw new BackfillRefusedError(`Unknown job ${jobId}; see \`list\``);
    const job = jobs[jobId]();
    const store = new BackfillStateStore(typeof flags['state-dir'] === 'string' ? flags['state-dir'] : BackfillStateStore.defaultDir());
    const runner = new BackfillRunner(store);
    const common = {
      batchSize: intFlag(flags, 'batch-size'),
      limit: intFlag(flags, 'limit'),
      maxFailures: intFlag(flags, 'max-failures'),
      resume: flags.resume === true,
      restart: flags.restart === true,
      retryFailed: flags['retry-failed'] === true,
    };

    switch (command) {
      case 'plan': {
        const report = await runner.preview(job, common);
        emit(io, flags, report);
        return report.failed.length > 0 ? EXIT.PARTIAL : EXIT.OK;
      }
      case 'apply': {
        const report = await runner.apply(job, {
          ...common,
          confirmPlan: typeof flags['confirm-plan'] === 'string' ? flags['confirm-plan'] : undefined,
          forceUnlock: flags['force-unlock'] === true,
          shouldStop: io.shouldStop,
        });
        emit(io, flags, report);
        if (report.status !== 'completed') return EXIT.INCOMPLETE;
        return report.failed.length > 0 ? EXIT.PARTIAL : EXIT.OK;
      }
      case 'status': {
        const checkpoint = runner.status(job.id);
        if (flags.json) io.out(JSON.stringify(checkpoint, null, 2));
        else io.out(checkpoint ? formatCheckpoint(checkpoint) : `No checkpoint for ${job.id}.`);
        return EXIT.OK;
      }
      case 'rollback': {
        if (typeof flags.run !== 'string') throw new BackfillRefusedError('rollback needs --run <runId>');
        const result = await runner.rollback(job, flags.run, {
          batchSize: common.batchSize,
          forceUnlock: flags['force-unlock'] === true,
        });
        emit(io, flags, result);
        return result.conflicts.length > 0 ? EXIT.PARTIAL : EXIT.OK;
      }
      default:
        throw new BackfillRefusedError(`Unknown command ${command}\n\n${USAGE}`);
    }
  } catch (error) {
    if (error instanceof BackfillRefusedError) {
      io.err(`Refused: ${error.message}`);
      return EXIT.REFUSED;
    }
    io.err(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.ERROR;
  }
}

function emit(io: CliIo, flags: ParsedArgs['flags'], result: BackfillReport | BackfillRestoreResult): void {
  if (typeof flags.out === 'string') fs.writeFileSync(flags.out, JSON.stringify(result, null, 2));
  if (flags.json) io.out(JSON.stringify(result, null, 2));
  else io.out('jobId' in result ? formatReport(result) : formatRestore(result));
}

export function formatReport(report: BackfillReport): string {
  const c = report.counters;
  const lines = [
    `${report.mode === 'dry-run' ? 'DRY RUN — nothing written' : `APPLY run ${report.runId}`}: ${report.jobId}@${report.jobVersion} → ${report.status}`,
  ];
  if (report.resumedFrom !== null) lines.push(`resumed after key ${report.resumedFrom}`);
  lines.push(`scanned ${c.scanned}, update ${c.updated}, unchanged ${c.unchanged}, skipped ${c.skipped}, failed ${c.failed}`);
  if (report.error) lines.push(`stopped: ${report.error}`);
  for (const d of report.diff) {
    lines.push(`~ ${d.key}`);
    for (const change of d.changes) lines.push(`    ${change}`);
  }
  for (const s of report.skipped) lines.push(`- skipped ${s.key}: ${s.reason}`);
  for (const f of report.failed) lines.push(`! failed  ${f.key}: ${f.error} (attempts ${f.attempts})`);
  if (report.mode === 'dry-run') {
    lines.push(`plan digest: ${report.planDigest}`);
    lines.push(`apply exactly this plan with: apply --job ${report.jobId} --confirm-plan ${report.planDigest}`);
  }
  lines.push(`rollback: ${report.rollback}`);
  return lines.join('\n');
}

function formatRestore(result: BackfillRestoreResult): string {
  const lines = [`restored ${result.restored.length}, conflicts ${result.conflicts.length}`];
  for (const c of result.conflicts) lines.push(`! conflict ${c.key}: ${c.reason}`);
  return lines.join('\n');
}

function formatCheckpoint(cp: BackfillCheckpoint): string {
  const c = cp.counters;
  return [
    `${cp.jobId}@${cp.jobVersion} run ${cp.runId}: ${cp.status}${cp.retryOf ? ` (retry of ${cp.retryOf})` : ''}`,
    `cursor ${JSON.stringify(cp.cursor)}, started ${cp.startedAt}, updated ${cp.updatedAt}`,
    `scanned ${c.scanned}, updated ${c.updated}, unchanged ${c.unchanged}, skipped ${c.skipped}, failed ${c.failed}`,
    ...(cp.error ? [`stopped: ${cp.error}`] : []),
    ...cp.failed.map((f) => `! failed  ${f.key}: ${f.error} (attempts ${f.attempts})`),
    ...cp.skipped.map((s) => `- skipped ${s.key}: ${s.reason}`),
  ].join('\n');
}
