import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { AuditRecord } from './interfaces/audit.interface';

/**
 * Durable, Redis-independent row store for the audit chain (issue #260).
 *
 * The API's in-memory stores lose data on restart, which defeats the point of
 * a tamper-evident history you can consult months later. `RedisService`
 * (`api/src/common/services/redis.service.ts`) is designed to degrade -- every
 * read/write there logs a warning and continues on failure. That is the right
 * behaviour for a cache but wrong for the only record of "did this record get
 * mutated, by whom, and with what before/after values".
 *
 * `DATABASE_URL` is already provisioned in `docker-compose.yml` and consumed
 * by `oracle-incident.repository.ts` (#95), so a Postgres table with no other
 * environment changes is available here. The table is created `IF NOT EXISTS`
 * on startup for the same reason that repository does its own DDL: the repo
 * has no migration tooling yet (that gap is issue #263).
 */
@Injectable()
export class AuditDurableStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditDurableStore.name);
  private readonly pool: Pool;

  constructor() {
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  async onModuleInit(): Promise<void> {
    await this.createTableIfMissing();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async append(record: AuditRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_history
        (entity_type, entity_id, sequence, record_id, action, actor, reason,
         before_state, after_state, recorded_at, previous_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.entityType,
        record.entityId,
        record.sequence,
        record.recordId,
        record.action,
        record.actor,
        record.reason ?? null,
        record.before ? JSON.stringify(record.before) : null,
        record.after ? JSON.stringify(record.after) : null,
        record.recordedAt,
        record.previousHash,
        record.hash,
      ],
    );
  }

  async load(entityType: string, entityId: string): Promise<AuditRecord[]> {
    const result = await this.pool.query(
      `SELECT entity_type, entity_id, sequence, record_id, action, actor, reason,
              before_state, after_state, recorded_at, previous_hash, hash
         FROM audit_history
        WHERE entity_type = $1 AND entity_id = $2
        ORDER BY sequence ASC`,
      [entityType, entityId],
    );

    return result.rows.map((row) => ({
      sequence: Number(row.sequence),
      recordId: row.record_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      actor: row.actor,
      reason: row.reason ?? undefined,
      before: row.before_state ? JSON.parse(row.before_state) : null,
      after: row.after_state ? JSON.parse(row.after_state) : null,
      recordedAt: new Date(row.recorded_at).toISOString(),
      previousHash: row.previous_hash,
      hash: row.hash,
    }));
  }

  async loadAllEntities(): Promise<Array<{ entityType: string; entityId: string }>> {
    const result = await this.pool.query(
      'SELECT DISTINCT entity_type, entity_id FROM audit_history ORDER BY entity_type, entity_id',
    );
    return result.rows.map((row) => ({ entityType: row.entity_type, entityId: row.entity_id }));
  }

  async count(): Promise<number> {
    const result = await this.pool.query('SELECT COUNT(*)::int AS count FROM audit_history');
    return Number(result.rows[0]?.count ?? 0);
  }

  private async createTableIfMissing(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS audit_history (
        id            BIGSERIAL PRIMARY KEY,
        entity_type   TEXT        NOT NULL,
        entity_id     TEXT        NOT NULL,
        sequence      INTEGER     NOT NULL,
        record_id     TEXT        NOT NULL,
        action        TEXT        NOT NULL,
        actor         TEXT        NOT NULL,
        reason        TEXT,
        before_state  JSONB,
        after_state   JSONB,
        recorded_at   TIMESTAMPTZ NOT NULL,
        previous_hash TEXT,
        hash          TEXT        NOT NULL,
        UNIQUE (entity_type, entity_id, sequence)
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_audit_history_entity
         ON audit_history (entity_type, entity_id, sequence)`,
    );
  }
}
