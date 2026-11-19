import * as crypto from 'crypto';

export type ConfigActorRole = 'ADMIN' | 'OPERATOR' | 'INVESTOR' | 'GUEST';

export interface SensitiveConfigAuditEntry {
  seq: number;
  changeId: string;
  action: 'config.updated' | 'config.rolled_back' | 'config.rejected';
  actorId: string;
  actorRole: ConfigActorRole;
  reason: string;
  changedKeys: string[];
  before: Record<string, string>;
  after: Record<string, string>;
  timestamp: string;
  prevHash: string;
  hash: string;
}

export interface SensitiveConfigChangeInput {
  changeId: string;
  actorId: string;
  actorRole: ConfigActorRole;
  reason: string;
  updates: Record<string, string>;
}

export interface SensitiveConfigChangeResult {
  status: 'applied' | 'unchanged' | 'replayed' | 'rolled_back';
  entry: SensitiveConfigAuditEntry | null;
  snapshot: Record<string, string>;
}

const REDACTED = '[REDACTED]';
const SECRET_KEY_PATTERN = /(secret|token|password|private[_-]?key|api[_-]?key)/i;
const ALLOWED_SENSITIVE_KEYS = new Set([
  'JWT_EXPIRY',
  'MAX_SLIPPAGE_BPS',
  'ORACLE_QUORUM',
  'MAINTENANCE_MODE',
  'FEE_TREASURY_ADDRESS',
  'SIGNING_SECRET_ROTATION_KEY',
]);

export class SensitiveConfigAuthorizationError extends Error {
  constructor(role: string) {
    super(`Unauthorized config actor role "${role}": ADMIN required.`);
    this.name = 'SensitiveConfigAuthorizationError';
  }
}

export class SensitiveConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SensitiveConfigConflictError';
  }
}

export class SensitiveConfigAuditService {
  private readonly state = new Map<string, string>();
  private readonly trail: SensitiveConfigAuditEntry[] = [];
  private readonly idempotency = new Map<string, { payloadHash: string; result: SensitiveConfigChangeResult }>();

  constructor(
    initialConfig: Record<string, string> = {},
    private readonly persistHook?: (entry: SensitiveConfigAuditEntry) => Promise<void>,
  ) {
    for (const [k, v] of Object.entries(initialConfig)) {
      this.state.set(k, v);
    }
  }

  getSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.state.entries()) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : v;
    }
    return out;
  }

  getAuditTrail(): readonly SensitiveConfigAuditEntry[] {
    return [...this.trail];
  }

  verifyChain(): boolean {
    let expectedPrev = 'GENESIS';
    for (const entry of this.trail) {
      if (entry.prevHash !== expectedPrev) return false;
      const recomputed = this.computeHash({ ...entry, hash: '' });
      if (entry.hash !== recomputed) return false;
      expectedPrev = entry.hash;
    }
    return true;
  }

  async applyChange(input: SensitiveConfigChangeInput): Promise<SensitiveConfigChangeResult> {
    if (input.actorRole !== 'ADMIN') {
      throw new SensitiveConfigAuthorizationError(input.actorRole);
    }
    if (!input.reason || !input.reason.trim()) {
      throw new Error('Audit reason is required for sensitive configuration changes.');
    }

    const payloadHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ reason: input.reason, updates: input.updates }))
      .digest('hex');

    const existing = this.idempotency.get(input.changeId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new SensitiveConfigConflictError(
          `changeId "${input.changeId}" already used with a different payload.`,
        );
      }
      return { ...existing.result, status: 'replayed' };
    }

    const changedKeys = Object.keys(input.updates).sort();
    for (const key of changedKeys) {
      if (!ALLOWED_SENSITIVE_KEYS.has(key)) {
        throw new Error(`Unknown or disallowed sensitive config key: "${key}"`);
      }
    }

    const actualChanges = changedKeys.filter((k) => this.state.get(k) !== input.updates[k]);
    if (actualChanges.length === 0) {
      const unchanged: SensitiveConfigChangeResult = {
        status: 'unchanged',
        entry: null,
        snapshot: this.getSnapshot(),
      };
      this.idempotency.set(input.changeId, { payloadHash, result: unchanged });
      return unchanged;
    }

    const before = this.getSnapshot();
    const afterRaw = new Map(this.state);
    for (const k of actualChanges) {
      afterRaw.set(k, input.updates[k]);
    }
    const after: Record<string, string> = {};
    for (const [k, v] of afterRaw.entries()) {
      after[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : v;
    }

    const entry = await this.appendEntry({
      changeId: input.changeId,
      action: 'config.updated',
      actorId: input.actorId,
      actorRole: input.actorRole,
      reason: input.reason.trim(),
      changedKeys: actualChanges,
      before,
      after,
    });

    // Commit in-memory state only AFTER audit evidence persists
    for (const k of actualChanges) {
      this.state.set(k, input.updates[k]);
    }

    const result: SensitiveConfigChangeResult = {
      status: 'applied',
      entry,
      snapshot: this.getSnapshot(),
    };
    this.idempotency.set(input.changeId, { payloadHash, result });
    return result;
  }

  async rollbackChange(params: {
    changeId: string;
    targetChangeId: string;
    actorId: string;
    actorRole: ConfigActorRole;
    reason: string;
  }): Promise<SensitiveConfigChangeResult> {
    if (params.actorRole !== 'ADMIN') {
      throw new SensitiveConfigAuthorizationError(params.actorRole);
    }
    if (!this.verifyChain()) {
      throw new SensitiveConfigConflictError('Audit chain verification failed; rollback refused.');
    }

    const target = this.trail.find(
      (e) => e.changeId === params.targetChangeId && e.action === 'config.updated',
    );
    if (!target) {
      throw new Error(`Target changeId "${params.targetChangeId}" not found.`);
    }

    const before = this.getSnapshot();
    const restoredRaw = new Map(this.state);
    for (const k of target.changedKeys) {
      if (k in target.before) {
        restoredRaw.set(k, target.before[k]);
      } else {
        restoredRaw.delete(k);
      }
    }
    const after: Record<string, string> = {};
    for (const [k, v] of restoredRaw.entries()) {
      after[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : v;
    }

    const entry = await this.appendEntry({
      changeId: params.changeId,
      action: 'config.rolled_back',
      actorId: params.actorId,
      actorRole: params.actorRole,
      reason: `${params.reason.trim()} (rolledBack: ${params.targetChangeId})`,
      changedKeys: target.changedKeys,
      before,
      after,
    });

    for (const k of target.changedKeys) {
      if (k in target.before) {
        this.state.set(k, target.before[k]);
      } else {
        this.state.delete(k);
      }
    }

    return {
      status: 'rolled_back',
      entry,
      snapshot: this.getSnapshot(),
    };
  }

  private async appendEntry(
    partial: Omit<SensitiveConfigAuditEntry, 'seq' | 'timestamp' | 'prevHash' | 'hash'>,
  ): Promise<SensitiveConfigAuditEntry> {
    const prevHash = this.trail.length > 0 ? this.trail[this.trail.length - 1].hash : 'GENESIS';
    const draft: SensitiveConfigAuditEntry = {
      ...partial,
      seq: this.trail.length + 1,
      timestamp: new Date().toISOString(),
      prevHash,
      hash: '',
    };
    draft.hash = this.computeHash(draft);

    if (this.persistHook) {
      await this.persistHook(draft);
    }
    this.trail.push(draft);
    return draft;
  }

  private computeHash(entry: SensitiveConfigAuditEntry): string {
    const canonical = JSON.stringify({
      seq: entry.seq,
      changeId: entry.changeId,
      action: entry.action,
      actorId: entry.actorId,
      actorRole: entry.actorRole,
      reason: entry.reason,
      changedKeys: entry.changedKeys,
      before: entry.before,
      after: entry.after,
      timestamp: entry.timestamp,
      prevHash: entry.prevHash,
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }
}
