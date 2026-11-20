import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { Pool } from 'pg';
import { stableStringify } from '../../audit/audit.canonical';
import { ComplianceRulesEngine } from './compliance-rules.engine';

export const COMPLIANCE_SNAPSHOT_SCHEMA_VERSION = 1;
export type CriticalLifecycleEvent = 'BOND_ISSUED' | 'BOND_SUBSCRIBED' | 'COUPON_DISTRIBUTED' | 'BOND_MATURED';

export interface ComplianceSnapshot {
  eventId: string;
  eventType: CriticalLifecycleEvent;
  bondId: number;
  schemaVersion: number;
  capturedAt: string;
  payload: Record<string, unknown>;
  hash: string;
}

export function snapshotHash(snapshot: Omit<ComplianceSnapshot, 'hash'>): string {
  return createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

@Injectable()
export class ComplianceSnapshotService implements OnModuleInit, OnModuleDestroy {
  private readonly pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
  private readonly snapshots = new Map<string, ComplianceSnapshot>();

  constructor(private readonly rulesEngine: ComplianceRulesEngine) {}

  async onModuleInit(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(`CREATE TABLE IF NOT EXISTS compliance_snapshots (
      event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, bond_id BIGINT NOT NULL,
      schema_version INTEGER NOT NULL, captured_at TIMESTAMPTZ NOT NULL,
      payload TEXT NOT NULL, hash TEXT NOT NULL
    )`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_compliance_snapshots_bond
      ON compliance_snapshots (bond_id, captured_at)`);
    await this.pool.query(`CREATE OR REPLACE FUNCTION reject_compliance_snapshot_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'compliance snapshots are immutable'; END;
      $$`);
    await this.pool.query(`DROP TRIGGER IF EXISTS compliance_snapshots_immutable ON compliance_snapshots`);
    await this.pool.query(`CREATE TRIGGER compliance_snapshots_immutable
      BEFORE UPDATE OR DELETE ON compliance_snapshots
      FOR EACH ROW EXECUTE FUNCTION reject_compliance_snapshot_mutation()`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  async capture(eventId: string, eventType: CriticalLifecycleEvent, bondId: number,
    eventData: Record<string, unknown>): Promise<ComplianceSnapshot> {
    if (!eventId || !Number.isSafeInteger(bondId) || bondId < 1) throw new Error('Valid event and bond IDs required');
    const existing = await this.get(eventId);
    if (existing) return existing;
    const content: Omit<ComplianceSnapshot, 'hash'> = {
      eventId, eventType, bondId, schemaVersion: COMPLIANCE_SNAPSHOT_SCHEMA_VERSION,
      capturedAt: new Date().toISOString(),
      payload: JSON.parse(stableStringify({ eventData, ruleset: this.rulesEngine.getActiveRuleset() })),
    };
    const snapshot = { ...content, hash: snapshotHash(content) };
    if (this.pool) {
      await this.pool.query(`INSERT INTO compliance_snapshots
        (event_id, event_type, bond_id, schema_version, captured_at, payload, hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, eventType, bondId, snapshot.schemaVersion, snapshot.capturedAt,
        stableStringify(snapshot.payload), snapshot.hash]);
      return (await this.get(eventId))!;
    }
    this.snapshots.set(eventId, snapshot);
    return structuredClone(snapshot);
  }

  async get(eventId: string): Promise<ComplianceSnapshot | null> {
    if (this.pool) {
      const result = await this.pool.query(`SELECT event_id, event_type, bond_id,
        schema_version, captured_at, payload, hash FROM compliance_snapshots WHERE event_id = $1`, [eventId]);
      if (!result.rows.length) return null;
      const row = result.rows[0];
      return { eventId: row.event_id, eventType: row.event_type, bondId: Number(row.bond_id),
        schemaVersion: row.schema_version, capturedAt: new Date(row.captured_at).toISOString(),
        payload: JSON.parse(row.payload), hash: row.hash };
    }
    const snapshot = this.snapshots.get(eventId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  verify(snapshot: ComplianceSnapshot): boolean {
    const { hash, ...content } = snapshot;
    return hash === snapshotHash(content);
  }
}
