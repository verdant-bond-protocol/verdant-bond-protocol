import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { stableStringify } from '../audit/audit.canonical';
import { LedgerCheckpoint, LedgerEvent } from './ledger.types';

export const LEDGER_STORE = Symbol('LEDGER_STORE');

/**
 * Persistence for the ledger. Implementations must be append-only: there is
 * deliberately no update or delete in this interface.
 */
export interface LedgerStore {
  init(): Promise<void>;
  close(): Promise<void>;
  /** Must fail (not overwrite) if `event.sequence` already exists. */
  appendEvent(event: LedgerEvent): Promise<void>;
  loadEvents(): Promise<LedgerEvent[]>;
  appendCheckpoint(checkpoint: LedgerCheckpoint): Promise<void>;
  loadCheckpoints(): Promise<LedgerCheckpoint[]>;
}

/**
 * Default store. Lost on restart, so only suitable for development and
 * tests; production sets `LEDGER_STORE=postgres`.
 */
export class InMemoryLedgerStore implements LedgerStore {
  // Exposed so tests can simulate storage-level tampering.
  readonly events: LedgerEvent[] = [];
  readonly checkpoints: LedgerCheckpoint[] = [];

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async appendEvent(event: LedgerEvent): Promise<void> {
    if (this.events.some((e) => e.sequence === event.sequence)) {
      throw new Error(`ledger sequence ${event.sequence} already exists`);
    }
    // Deep copy so later mutation of the caller's object cannot reach storage.
    this.events.push(JSON.parse(JSON.stringify(event)));
  }

  async loadEvents(): Promise<LedgerEvent[]> {
    return [...this.events].sort((a, b) => a.sequence - b.sequence).map((e) => JSON.parse(JSON.stringify(e)));
  }

  async appendCheckpoint(checkpoint: LedgerCheckpoint): Promise<void> {
    this.checkpoints.push({ ...checkpoint });
  }

  async loadCheckpoints(): Promise<LedgerCheckpoint[]> {
    return this.checkpoints.map((c) => ({ ...c }));
  }
}

/**
 * Postgres store. Each event is kept as its exact canonical JSON in `body`
 * (TEXT, not JSONB) so the bytes that were hashed are the bytes read back;
 * JSONB would re-normalise numbers and whitespace. Indexed columns duplicate
 * a few fields for querying only and are never trusted for verification.
 *
 * Triggers reject UPDATE, DELETE and TRUNCATE, so tampering requires a
 * superuser disabling triggers -- which the hash chain and checkpoint MACs
 * then detect. `UNIQUE (sequence)` makes a second writer fail rather than fork
 * the chain.
 */
export class PostgresLedgerStore implements LedgerStore {
  private readonly logger = new Logger(PostgresLedgerStore.name);

  constructor(private readonly pool: Pick<Pool, 'query' | 'end' | 'on'> = new Pool({ connectionString: process.env.DATABASE_URL })) {
    this.pool.on('error', (error: Error) => this.logger.warn(`Idle Postgres client error: ${error.message}`));
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        sequence     BIGINT      PRIMARY KEY,
        event_id     TEXT        NOT NULL UNIQUE,
        category     TEXT        NOT NULL,
        type         TEXT        NOT NULL,
        subject_type TEXT        NOT NULL,
        subject_id   TEXT        NOT NULL,
        recorded_at  TIMESTAMPTZ NOT NULL,
        hash         TEXT        NOT NULL,
        body         TEXT        NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ledger_checkpoints (
        sequence   BIGINT PRIMARY KEY,
        body       TEXT   NOT NULL
      )
    `);
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS idx_ledger_events_subject ON ledger_events (subject_type, subject_id, sequence)',
    );
    await this.pool.query(`
      CREATE OR REPLACE FUNCTION ledger_reject_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'ledger tables are append-only (% on %)', TG_OP, TG_TABLE_NAME;
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const table of ['ledger_events', 'ledger_checkpoints']) {
      await this.pool.query(`DROP TRIGGER IF EXISTS ${table}_append_only ON ${table}`);
      await this.pool.query(
        `CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table}
           FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation()`,
      );
      await this.pool.query(`DROP TRIGGER IF EXISTS ${table}_no_truncate ON ${table}`);
      await this.pool.query(
        `CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
           FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation()`,
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async appendEvent(event: LedgerEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO ledger_events
         (sequence, event_id, category, type, subject_type, subject_id, recorded_at, hash, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.sequence,
        event.eventId,
        event.category,
        event.type,
        event.subjectType,
        event.subjectId,
        event.recordedAt,
        event.hash,
        stableStringify(event),
      ],
    );
  }

  async loadEvents(): Promise<LedgerEvent[]> {
    const result = await this.pool.query('SELECT body FROM ledger_events ORDER BY sequence ASC');
    return result.rows.map((row: { body: string }) => JSON.parse(row.body));
  }

  async appendCheckpoint(checkpoint: LedgerCheckpoint): Promise<void> {
    await this.pool.query('INSERT INTO ledger_checkpoints (sequence, body) VALUES ($1, $2)', [
      checkpoint.sequence,
      stableStringify(checkpoint),
    ]);
  }

  async loadCheckpoints(): Promise<LedgerCheckpoint[]> {
    const result = await this.pool.query('SELECT body FROM ledger_checkpoints ORDER BY sequence ASC');
    return result.rows.map((row: { body: string }) => JSON.parse(row.body));
  }
}

export function createLedgerStoreFromEnv(): LedgerStore {
  return process.env.LEDGER_STORE === 'postgres' ? new PostgresLedgerStore() : new InMemoryLedgerStore();
}
