import { createHash, randomUUID } from 'crypto';
import { RepairCheckpointStore } from './repair-checkpoint.store';
import {
  canApply,
  canPlan,
  RepairActor,
  RepairAuthorizationError,
  RepairCheckpoint,
  RepairJob,
  RepairRefusedError,
  RepairReport,
  RepairReportStep,
} from './repair-tool.interface';

export interface ApplyOptions {
  actor: RepairActor;
  /** Resume an existing run instead of creating a new one. */
  runId?: string;
  /** Refuse to apply unless the plan digest matches (recommended). */
  confirmPlan?: string;
  maxFailures?: number;
  shouldStop?: () => boolean;
}

/**
 * Deterministic, checkpointed repair runner.
 *
 * `plan` is a strict dry run: it calls only the READ-ONLY `inspect` hooks,
 * writes nothing, and produces a digest of the exact steps it would take.
 * `apply` persists a checkpoint *before* the first write and after every step,
 * so an interrupted run can be resumed without re-applying finished work.
 * `rollback` walks applied steps in reverse using their compensating actions.
 */
export class RepairRunner {
  constructor(private readonly store: RepairCheckpointStore) {}

  /** Stable digest over step ids + descriptions (order matters). */
  digest(job: RepairJob): string {
    const body = [job.id, ...job.steps.map((s) => `${s.id}:${s.description}`)].join('\n');
    return createHash('sha256').update(body).digest('hex').slice(0, 16);
  }

  async plan(job: RepairJob, actor: RepairActor): Promise<RepairReport> {
    if (!canPlan(actor)) {
      throw new RepairAuthorizationError('plan requires ops:read or ops:repair permission');
    }
    const steps: RepairReportStep[] = [];
    for (const step of job.steps) {
      let healthy: boolean;
      let lastError: string | undefined;
      try {
        healthy = await step.inspect();
      } catch (error) {
        healthy = false;
        lastError = `inspect failed: ${message(error)}`;
      }
      steps.push({
        id: step.id,
        description: step.description,
        healthy,
        state: healthy ? 'skipped' : 'pending',
        ...(lastError ? { lastError } : {}),
      });
    }
    return {
      runId: 'dry-run',
      jobId: job.id,
      mode: 'dry-run',
      status: 'completed',
      planDigest: this.digest(job),
      steps,
      counters: {
        applied: 0,
        skipped: steps.filter((s) => s.healthy).length,
        failed: 0,
        rolledBack: 0,
      },
    };
  }

  async apply(job: RepairJob, options: ApplyOptions): Promise<RepairReport> {
    if (!canApply(options.actor)) {
      throw new RepairAuthorizationError('apply requires ops:repair permission');
    }
    const planDigest = this.digest(job);
    if (options.confirmPlan !== undefined && options.confirmPlan !== planDigest) {
      throw new RepairRefusedError(
        `plan digest mismatch: expected ${planDigest}, got ${options.confirmPlan}. Re-run plan and confirm the new plan.`,
      );
    }

    let checkpoint: RepairCheckpoint | null | undefined;
    if (options.runId !== undefined) {
      checkpoint = await this.store.load(options.runId);
      if (!checkpoint) throw new RepairRefusedError(`no checkpoint for run "${options.runId}"`);
      if (checkpoint.jobId !== job.id || checkpoint.planDigest !== planDigest) {
        throw new RepairRefusedError('job changed since the checkpoint was created; restart instead of resuming');
      }
    } else {
      checkpoint = {
        runId: `${job.id.replace(/[^A-Za-z0-9._-]+/g, '-')}-${Date.now()}-${randomUUID().slice(0, 8)}`,
        jobId: job.id,
        planDigest,
        state: 'applying',
        actor: options.actor.id,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: job.steps.map((s) => ({ id: s.id, description: s.description, state: 'pending', attempts: 0 })),
      };
    }

    checkpoint.state = 'applying';
    checkpoint.updatedAt = new Date().toISOString();
    await this.store.save(checkpoint); // durable intent before any side effect

    const steps = new Map(job.steps.map((s) => [s.id, s]));
    let failures = 0;
    let stopped = false;
    for (const tracked of checkpoint.steps) {
      if (options.shouldStop?.()) {
        stopped = true;
        break;
      }
      if (tracked.state === 'applied' || tracked.state === 'skipped') continue;

      const step = steps.get(tracked.id);
      if (!step) throw new RepairRefusedError(`checkpoint references unknown step "${tracked.id}"`);

      let healthy: boolean;
      try {
        healthy = await step.inspect();
      } catch (error) {
        tracked.state = 'failed';
        tracked.lastError = `inspect failed: ${message(error)}`;
        failures++;
        checkpoint.updatedAt = new Date().toISOString();
        await this.store.save(checkpoint);
        continue;
      }
      if (healthy) {
        // Already repaired (possibly by a previous partial run): safe no-op.
        tracked.state = 'skipped';
        tracked.lastError = undefined;
        checkpoint.updatedAt = new Date().toISOString();
        await this.store.save(checkpoint);
        continue;
      }

      tracked.attempts++;
      try {
        await step.apply();
        tracked.state = 'applied';
        tracked.lastError = undefined;
      } catch (error) {
        tracked.state = 'failed';
        tracked.lastError = message(error);
        failures++;
      }
      checkpoint.updatedAt = new Date().toISOString();
      await this.store.save(checkpoint); // checkpoint after every step

      if (failures >= (options.maxFailures ?? 25)) break;
    }

    checkpoint.state = failures > 0 ? 'failed' : stopped ? 'failed' : 'applied';
    checkpoint.updatedAt = new Date().toISOString();
    await this.store.save(checkpoint);

    const status = stopped ? 'incomplete' : failures > 0 ? 'failed' : 'completed';
    return this.report(checkpoint, 'apply', status, { stopped });
  }

  async resume(runId: string, job: RepairJob, actor: RepairActor): Promise<RepairReport> {
    if (!canApply(actor)) {
      throw new RepairAuthorizationError('resume requires ops:repair permission');
    }
    const checkpoint = await this.store.load(runId);
    if (!checkpoint) throw new RepairRefusedError(`no checkpoint for run "${runId}"`);
    return this.apply(job, { actor, runId });
  }

  async rollback(
    runId: string,
    job: RepairJob,
    actor: RepairActor,
  ): Promise<{ report: RepairReport; conflicts: string[] }> {
    if (!canApply(actor)) {
      throw new RepairAuthorizationError('rollback requires ops:repair permission');
    }
    const checkpoint = await this.store.load(runId);
    if (!checkpoint) throw new RepairRefusedError(`no checkpoint for run "${runId}"`);
    if (checkpoint.planDigest !== this.digest(job)) {
      throw new RepairRefusedError('job changed since the checkpoint was created; refusing rollback');
    }

    const steps = new Map(job.steps.map((s) => [s.id, s]));
    const conflicts: string[] = [];
    for (const tracked of [...checkpoint.steps].reverse()) {
      if (tracked.state !== 'applied') continue;
      const step = steps.get(tracked.id);
      if (!step?.rollback) {
        conflicts.push(`${tracked.id}: no rollback action`);
        tracked.lastError = 'no rollback action';
        continue;
      }
      try {
        await step.rollback();
        tracked.state = 'rolled-back';
        tracked.lastError = undefined;
      } catch (error) {
        conflicts.push(`${tracked.id}: ${message(error)}`);
        tracked.lastError = `rollback failed: ${message(error)}`;
      }
      checkpoint.updatedAt = new Date().toISOString();
      await this.store.save(checkpoint);
    }
    checkpoint.state = conflicts.length > 0 ? 'failed' : 'rolled-back';
    checkpoint.updatedAt = new Date().toISOString();
    await this.store.save(checkpoint);
    return {
      report: this.report(checkpoint, 'rollback', conflicts.length > 0 ? 'failed' : 'completed', { conflicts }),
      conflicts,
    };
  }

  async status(runId: string, actor: RepairActor): Promise<RepairCheckpoint> {
    if (!canPlan(actor)) throw new RepairAuthorizationError('status requires ops:read permission');
    const checkpoint = await this.store.load(runId);
    if (!checkpoint) throw new RepairRefusedError(`no checkpoint for run "${runId}"`);
    return checkpoint;
  }

  async list(actor: RepairActor): Promise<RepairCheckpoint[]> {
    if (!canPlan(actor)) throw new RepairAuthorizationError('list requires ops:read permission');
    return this.store.list();
  }

  private report(
    checkpoint: RepairCheckpoint,
    mode: RepairReport['mode'],
    status: RepairReport['status'],
    extra: { stopped?: boolean; conflicts?: string[] } = {},
  ): RepairReport {
    const steps: RepairReportStep[] = checkpoint.steps.map((s) => ({
      id: s.id,
      description: s.description,
      state: s.state,
      healthy: s.state === 'skipped',
      ...(s.lastError ? { lastError: s.lastError } : {}),
    }));
    return {
      runId: checkpoint.runId,
      jobId: checkpoint.jobId,
      mode,
      status,
      planDigest: checkpoint.planDigest,
      steps,
      counters: {
        applied: steps.filter((s) => s.state === 'applied').length,
        skipped: steps.filter((s) => s.state === 'skipped').length,
        failed: steps.filter((s) => s.state === 'failed').length,
        rolledBack: steps.filter((s) => s.state === 'rolled-back').length,
      },
      ...(extra.stopped ? { error: 'stopped early' } : {}),
      ...(extra.conflicts?.length ? { error: `${extra.conflicts.length} rollback conflict(s)` } : {}),
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
