import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/services/redis.service';
import {
  SideEffectCheckpoint,
  SideEffectRunOptions,
  SideEffectState,
  SideEffectError,
} from './side-effect-checkpoint.interface';

/**
 * Durable recovery checkpoints wrapped around every external side effect
 * (issue #405).
 *
 * The service records a checkpoint *before* an effect runs and again once the
 * outcome is known, so an interrupted or ambiguously-failed effect can be
 * repaired deterministically instead of being blindly retried. Redis mirrors
 * the checkpoint so it survives a process restart; an in-process map is the
 * fast path and the fallback when Redis is unavailable.
 *
 * See `docs/side-effect-recovery.md` for the state machine and recovery
 * matrix.
 */
@Injectable()
export class SideEffectCheckpointService {
  private readonly logger = new Logger(SideEffectCheckpointService.name);
  private readonly KEY_PREFIX = 'sideeffect:';
  private readonly memory = new Map<string, SideEffectCheckpoint>();

  constructor(private readonly redis: RedisService) {}

  /**
   * Wrap a single external side effect in a checkpoint.
   *
   * Never throws: the outcome is always reflected in the returned checkpoint's
   * `state`, so a caller (or an operator repairing it later) can decide what
   * to do. `applied`/`verified` mean it is done; `failed` is safe to retry;
   * `unknown` must be probed before retrying.
   */
  async run(options: SideEffectRunOptions): Promise<SideEffectCheckpoint> {
    const now = new Date().toISOString();
    const existing = await this.get(options.key);
    const checkpoint: SideEffectCheckpoint = {
      key: options.key,
      description: options.description ?? options.key,
      state: 'started',
      attempts: (existing?.attempts ?? 0) + 1,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      context: options.context ?? existing?.context,
    };
    await this.persist(checkpoint);

    try {
      await options.execute();
      const applied = await this.mark(checkpoint, 'applied', { appliedAt: now });
      this.logger.log(`side effect applied: ${options.key} (attempt ${applied.attempts})`);
      return applied;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const ambiguous = options.probe !== undefined;

      if (ambiguous) {
        return await this.resolveAmbiguous(options, checkpoint, message);
      }

      const failed = await this.mark(checkpoint, 'failed', { lastError: message });
      this.logger.warn(`side effect failed: ${options.key}: ${message}`);
      return failed;
    }
  }

  /**
   * Repair/resume a previously checkpointed effect.
   *
   * - `applied` / `verified`  -> no-op (idempotent, never re-runs).
   * - `failed`                -> re-runs `execute`.
   * - `unknown` / `started`   -> probes first; marks `verified` if it already
   *   landed, otherwise re-runs it. Without a probe it stays `unknown` for an
   *   operator rather than risking a double-apply.
   */
  async resume(
    key: string,
    execute: () => Promise<void>,
    probe?: () => Promise<boolean>,
  ): Promise<SideEffectCheckpoint> {
    const existing = await this.get(key);
    if (!existing) {
      throw new SideEffectError(`no checkpoint for "${key}"`, key, 'failed');
    }

    if (existing.state === 'applied' || existing.state === 'verified') {
      return existing;
    }

    if (existing.state === 'started' || existing.state === 'unknown') {
      if (!probe) {
        // Cannot decide safely; leave it for an operator.
        return await this.mark(existing, 'unknown', {
          lastError: existing.lastError ?? 'outcome unknown; provide a probe to resolve',
        });
      }
      let applied: boolean;
      try {
        applied = await probe();
      } catch (probeError) {
        const message = probeError instanceof Error ? probeError.message : String(probeError);
        return await this.mark(existing, 'unknown', { lastError: `probe failed: ${message}` });
      }
      if (applied) {
        return await this.mark(existing, 'verified', {
          appliedAt: new Date().toISOString(),
          lastError: existing.lastError,
        });
      }
      existing.state = 'failed';
    }

    // `failed` (or resolved to failed) -> re-execute under a fresh checkpoint.
    return await this.run({
      key: existing.key,
      description: existing.description,
      execute,
      probe,
      context: existing.context,
    });
  }

  async get(key: string): Promise<SideEffectCheckpoint | null> {
    const inMemory = this.memory.get(key);
    if (inMemory) return inMemory;

    const raw = await this.redis.get(`${this.KEY_PREFIX}${key}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as SideEffectCheckpoint;
      this.memory.set(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  async list(prefix = ''): Promise<SideEffectCheckpoint[]> {
    const seen = new Map<string, SideEffectCheckpoint>();
    for (const [key, value] of this.memory) {
      if (key.startsWith(prefix)) seen.set(key, value);
    }
    const keys = await this.redis.scanKeys(`${this.KEY_PREFIX}*`);
    for (const redisKey of keys) {
      const key = redisKey.slice(this.KEY_PREFIX.length);
      if (!key.startsWith(prefix) || seen.has(key)) continue;
      const checkpoint = await this.get(key);
      if (checkpoint) seen.set(key, checkpoint);
    }
    return [...seen.values()];
  }

  /** Checkpoints whose effect is neither known-done nor safely-retried. */
  async getPending(prefix = ''): Promise<SideEffectCheckpoint[]> {
    const all = await this.list(prefix);
    return all.filter((c) => c.state === 'unknown' || c.state === 'started');
  }

  clear(): void {
    this.memory.clear();
  }

  private async resolveAmbiguous(
    options: SideEffectRunOptions,
    checkpoint: SideEffectCheckpoint,
    message: string,
  ): Promise<SideEffectCheckpoint> {
    try {
      const applied = await options.probe!();
      if (applied) {
        return await this.mark(checkpoint, 'verified', {
          appliedAt: new Date().toISOString(),
          lastError: message,
        });
      }
      return await this.mark(checkpoint, 'failed', { lastError: message });
    } catch (probeError) {
      const probeMessage = probeError instanceof Error ? probeError.message : String(probeError);
      return await this.mark(checkpoint, 'unknown', {
        lastError: `${message} (probe failed: ${probeMessage})`,
      });
    }
  }

  private async mark(
    checkpoint: SideEffectCheckpoint,
    state: SideEffectState,
    extra: { lastError?: string; appliedAt?: string } = {},
  ): Promise<SideEffectCheckpoint> {
    checkpoint.state = state;
    checkpoint.updatedAt = new Date().toISOString();
    if (extra.lastError !== undefined) checkpoint.lastError = extra.lastError;
    if (extra.appliedAt !== undefined) checkpoint.appliedAt = extra.appliedAt;
    if (state === 'verified' && !checkpoint.appliedAt) {
      checkpoint.appliedAt = checkpoint.updatedAt;
    }
    await this.persist(checkpoint);
    return checkpoint;
  }

  private async persist(checkpoint: SideEffectCheckpoint): Promise<void> {
    this.memory.set(checkpoint.key, checkpoint);
    await this.redis.set(
      `${this.KEY_PREFIX}${checkpoint.key}`,
      JSON.stringify(checkpoint),
      { EX: 60 * 60 * 24 * 30 },
    );
  }
}
