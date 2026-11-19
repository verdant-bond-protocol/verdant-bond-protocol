import * as fs from 'fs';
import { RepairCheckpointStore } from './repair-checkpoint.store';
import { DEFAULT_REPAIR_JOBS, RepairJobFactory } from './repair-jobs';
import { RepairRunner } from './repair-runner';
import { RepairActor, RepairAuthorizationError, RepairReport, RepairRefusedError } from './repair-tool.interface';

export const REPAIR_EXIT = {
  OK: 0,
  ERROR: 1,
  REFUSED: 2,
  PARTIAL: 3,
  INCOMPLETE: 4,
} as const;

export const REPAIR_USAGE = `Usage: npm run repair -- <command> --job <id> [options]

Commands:
  list                       List registered repair jobs
  plan                       Dry run: inspect only, write nothing, print digest
  apply                      Apply in checkpoints; resume/retry on interruption
  status --run <id>          Show a run's checkpoint
  resume --run <id>          Continue an interrupted run (retries failed steps)
  rollback --run <id>        Restore before-images in reverse order

Options:
  --job <id>                 Job id (see \`list\`)
  --run <id>                 Checkpoint run id (status/resume/rollback)
  --confirm-plan <digest>    Refuse to apply unless the plan digest matches
  --max-failures <n>         Stop after n failed steps (default 25)
  --actor <id>               Operator id (default $REPAIR_ACTOR or anonymous)
  --permissions <a,b>        Operator scopes (default $REPAIR_PERMISSIONS)
  --file <path>              Target snapshot for the built-in holders:dedupe job
  --state-dir <dir>          Checkpoint dir (default $REPAIR_STATE_DIR or data/repair)
  --out <file>               Also write the full JSON report
  --json                     Print JSON instead of a summary
  --help                     Show this help

Reading needs ops:read; applying/resuming/rolling back needs ops:repair.
`;

const VALUE_FLAGS = new Set([
  'job', 'run', 'confirm-plan', 'max-failures', 'actor', 'permissions',
  'file', 'state-dir', 'out',
]);
const BOOL_FLAGS = new Set(['json', 'help']);

export interface ParsedRepairArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

export function parseRepairArgs(argv: string[]): ParsedRepairArgs {
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (command) throw new RepairRefusedError(`Unexpected argument ${arg}`);
      command = arg;
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (BOOL_FLAGS.has(name)) flags[name] = true;
    else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith('--')) throw new RepairRefusedError(`--${name} needs a value`);
      flags[name] = value;
    } else throw new RepairRefusedError(`Unknown option --${name}`);
  }
  return { command: command ?? 'plan', flags };
}

function actorFrom(flags: ParsedRepairArgs['flags']): RepairActor {
  const raw = typeof flags.permissions === 'string'
    ? flags.permissions
    : process.env.REPAIR_PERMISSIONS ?? '';
  return {
    id: typeof flags.actor === 'string' ? flags.actor : process.env.REPAIR_ACTOR ?? 'anonymous',
    permissions: raw.split(',').map((p) => p.trim()).filter(Boolean),
  };
}

export interface RepairCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  jobs?: Record<string, RepairJobFactory>;
  shouldStop?: () => boolean;
}

export async function runRepairCli(argv: string[], io: RepairCliIo): Promise<number> {
  try {
    const { command, flags } = parseRepairArgs(argv);
    const jobs = io.jobs ?? DEFAULT_REPAIR_JOBS;
    if (flags.help) {
      io.out(REPAIR_USAGE);
      return REPAIR_EXIT.OK;
    }
    if (command === 'list') {
      for (const id of Object.keys(jobs)) io.out(id);
      return REPAIR_EXIT.OK;
    }

    const actor = actorFrom(flags);
    const stateDir = typeof flags['state-dir'] === 'string'
      ? flags['state-dir']
      : RepairCheckpointStore.defaultDir();
    const runner = new RepairRunner(new RepairCheckpointStore(stateDir));

    if (command === 'status') {
      const runId = typeof flags.run === 'string' ? flags.run : '';
      const checkpoint = await runner.status(runId, actor);
      emit(io, flags, checkpoint, null);
      return REPAIR_EXIT.OK;
    }

    if (command === 'resume' || command === 'rollback') {
      const runId = typeof flags.run === 'string' ? flags.run : '';
      const job = jobFrom(flags, jobs);
      if (command === 'resume') {
        const report = await runner.resume(runId, job, actor);
        emit(io, flags, report, null);
        return exitFor(report);
      }
      const { report, conflicts } = await runner.rollback(runId, job, actor);
      emit(io, flags, report, conflicts);
      return conflicts.length > 0 ? REPAIR_EXIT.PARTIAL : REPAIR_EXIT.OK;
    }

    const job = jobFrom(flags, jobs);
    if (command === 'plan') {
      const report = await runner.plan(job, actor);
      emit(io, flags, report, null);
      return REPAIR_EXIT.OK;
    }
    if (command === 'apply') {
      const report = await runner.apply(job, {
        actor,
        confirmPlan: typeof flags['confirm-plan'] === 'string' ? flags['confirm-plan'] : undefined,
        maxFailures: flags['max-failures'] === undefined ? undefined : Number(flags['max-failures']),
        shouldStop: io.shouldStop,
      });
      emit(io, flags, report, null);
      return exitFor(report);
    }
    throw new RepairRefusedError(`Unknown command ${command}\n\n${REPAIR_USAGE}`);
  } catch (error) {
    if (error instanceof RepairAuthorizationError || error instanceof RepairRefusedError) {
      io.err(`Refused: ${error.message}`);
      return REPAIR_EXIT.REFUSED;
    }
    io.err(`Repair failed: ${error instanceof Error ? error.message : String(error)}`);
    return REPAIR_EXIT.ERROR;
  }
}

function jobFrom(flags: ParsedRepairArgs['flags'], jobs: Record<string, RepairJobFactory>) {
  const jobId = typeof flags.job === 'string' ? flags.job : '';
  const factory = jobs[jobId];
  if (!factory) throw new RepairRefusedError(`Unknown job "${jobId}"; see \`list\``);
  return factory(flags);
}

function exitFor(report: RepairReport): number {
  if (report.status === 'incomplete') return REPAIR_EXIT.INCOMPLETE;
  if (report.counters.failed > 0) return REPAIR_EXIT.PARTIAL;
  return REPAIR_EXIT.OK;
}

function emit(
  io: RepairCliIo,
  flags: ParsedRepairArgs['flags'],
  result: RepairReport | unknown,
  conflicts: string[] | null,
): void {
  const json = JSON.stringify(result, null, 2);
  if (typeof flags.out === 'string') fs.writeFileSync(flags.out, json);
  if (flags.json) io.out(json);
  else io.out(format(result, conflicts));
}

function format(result: unknown, conflicts: string[] | null): string {
  const r = result as Partial<RepairReport> & { steps?: RepairReport['steps']; state?: string; runId?: string };
  const mode = r.mode === 'dry-run' ? 'DRY RUN' : r.mode?.toUpperCase();
  const lines = [mode ? `${mode} ${r.jobId} → ${r.status} (run ${r.runId})` : `run ${r.runId}: ${r.state}`];
  if (r.planDigest) lines.push(`plan digest: ${r.planDigest}`);
  for (const step of r.steps ?? []) {
    lines.push(`  ${step.state.padEnd(10)} ${step.id} — ${step.description}${step.lastError ? ` (${step.lastError})` : ''}`);
  }
  if (r.counters) {
    const c = r.counters;
    lines.push(`applied ${c.applied}, skipped ${c.skipped}, failed ${c.failed}, rolledBack ${c.rolledBack}`);
  }
  if (r.mode === 'dry-run') lines.push('Nothing written. Apply with: apply --job <id> --confirm-plan <digest>');
  for (const conflict of conflicts ?? []) lines.push(`! conflict ${conflict}`);
  return lines.join('\n');
}
