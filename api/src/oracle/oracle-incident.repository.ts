import { Injectable, Logger, OnModuleDestroy, OnModuleInit, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PaginatedResponse } from '../common/dto/pagination.dto';
import {
  IncidentDetectionInput,
  IncidentDetectionResult,
  OracleIncident,
  OracleIncidentDetails,
  OracleIncidentSeverity,
  OracleIncidentStatus,
} from './interfaces/oracle-incident.interface';

/**
 * Durable store for oracle incidents (issue #95).
 *
 * Postgres, not Redis, is the source of truth: the contributor guidance for
 * this issue is explicit that alerting state is operational/audit data, and
 * `RedisService` (`api/src/common/services/redis.service.ts`) is designed to
 * degrade -- every read/write there logs a warning and continues on failure
 * (see its `logDegraded`). That is the right behavior for a cache, but wrong
 * for the only record of "was this incident acknowledged and by whom."
 * `DATABASE_URL` is already provisioned in `docker-compose.yml` and
 * documented in `.env.example`/`README.md`; nothing in this API used it
 * before this table.
 *
 * Dedup and recurrence are both enforced by a single Postgres construct: a
 * partial unique index on `dedupe_key` scoped to non-resolved rows. An
 * `INSERT ... ON CONFLICT (dedupe_key) WHERE status <> 'resolved' DO UPDATE`
 * can therefore only ever match an *unresolved* incident for the same
 * subject -- a fresh INSERT proceeds instead once the prior one is resolved,
 * which is exactly a "recurrence" (a new incident row, not silently merged
 * into stale historical state). This is atomic at the database level, so
 * repeated or concurrent cron cycles (including multiple API replicas
 * evaluating the same cycle) cannot create duplicate active rows for the
 * same subject -- Postgres's own conflict resolution serializes it, with no
 * application-level locking required.
 */

interface EscalationThreshold {
  occurrences: number;
  severity: OracleIncidentSeverity;
}

const DEFAULT_ESCALATION_THRESHOLDS: EscalationThreshold[] = [
  { occurrences: 3, severity: OracleIncidentSeverity.Critical },
];

/**
 * Parses `ORACLE_INCIDENT_ESCALATION_THRESHOLDS` (format: "count:severity,count:severity",
 * e.g. "3:critical,10:critical") the same way `oracle.monitoring.service.ts`'s
 * `CADENCE_OVERRIDES` reads its own env override -- a small, explicit,
 * validated array, not a generic config framework. Invalid or unparseable
 * entries are skipped; an empty or entirely-invalid value falls back to the
 * default so a typo in configuration cannot silently disable escalation.
 */
function parseEscalationThresholds(raw: string | undefined): EscalationThreshold[] {
  if (!raw) return DEFAULT_ESCALATION_THRESHOLDS;

  const validSeverities = new Set(Object.values(OracleIncidentSeverity));
  const parsed: EscalationThreshold[] = [];
  for (const entry of raw.split(',')) {
    const [countRaw, severityRaw] = entry.split(':').map((part) => part.trim());
    const occurrences = Number(countRaw);
    if (Number.isFinite(occurrences) && occurrences > 0 && validSeverities.has(severityRaw as OracleIncidentSeverity)) {
      parsed.push({ occurrences, severity: severityRaw as OracleIncidentSeverity });
    }
  }
  return parsed.length > 0
    ? parsed.sort((a, b) => a.occurrences - b.occurrences)
    : DEFAULT_ESCALATION_THRESHOLDS;
}

/** O(k) in the number of configured thresholds (typically 1-3), not the occurrence count. */
function severityForOccurrenceCount(count: number, thresholds: EscalationThreshold[]): OracleIncidentSeverity {
  let severity = OracleIncidentSeverity.Warning;
  for (const threshold of thresholds) {
    if (count >= threshold.occurrences) severity = threshold.severity;
  }
  return severity;
}

export function buildDedupeKey(subjectType: string, subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}

interface IncidentRow {
  id: string;
  dedupe_key: string;
  subject_type: string;
  subject_id: string;
  status: string;
  severity: string;
  occurrence_count: number;
  first_detected_at: Date;
  last_detected_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
  details: OracleIncidentDetails | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class OracleIncidentRepository implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OracleIncidentRepository.name);
  private readonly pool: Pool;
  private readonly escalationThresholds: EscalationThreshold[];

  constructor() {
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    this.escalationThresholds = parseEscalationThresholds(
      process.env.ORACLE_INCIDENT_ESCALATION_THRESHOLDS,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS oracle_incidents (
        id UUID PRIMARY KEY,
        dedupe_key TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        severity TEXT NOT NULL DEFAULT 'warning',
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        first_detected_at TIMESTAMPTZ NOT NULL,
        last_detected_at TIMESTAMPTZ NOT NULL,
        acknowledged_at TIMESTAMPTZ,
        acknowledged_by TEXT,
        resolved_at TIMESTAMPTZ,
        resolved_by TEXT,
        resolution_note TEXT,
        details JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS oracle_incidents_active_dedupe_key
        ON oracle_incidents (dedupe_key)
        WHERE status <> 'resolved';

      CREATE INDEX IF NOT EXISTS oracle_incidents_status_idx ON oracle_incidents (status);
    `);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Record one detection of a stale condition. Creates a new incident if
   * none is currently unresolved for this subject (first occurrence, or a
   * recurrence after a prior incident was resolved); otherwise updates the
   * existing unresolved incident's occurrence count and detection metadata.
   *
   * O(1): a single indexed upsert, plus at most one follow-up single-row
   * update when the occurrence count crosses an escalation threshold.
   */
  async recordDetection(input: IncidentDetectionInput): Promise<IncidentDetectionResult> {
    const dedupeKey = buildDedupeKey(input.subjectType, input.subjectId);
    const id = randomUUID();

    const upsertResult = await this.pool.query<IncidentRow>(
      `
      INSERT INTO oracle_incidents (
        id, dedupe_key, subject_type, subject_id, status, severity,
        occurrence_count, first_detected_at, last_detected_at, details
      )
      VALUES ($1, $2, $3, $4, 'active', 'warning', 1, $5, $5, $6)
      ON CONFLICT (dedupe_key) WHERE status <> 'resolved'
      DO UPDATE SET
        occurrence_count = oracle_incidents.occurrence_count + 1,
        last_detected_at = EXCLUDED.last_detected_at,
        details = EXCLUDED.details,
        updated_at = now()
      RETURNING *;
      `,
      [id, dedupeKey, input.subjectType, input.subjectId, input.detectedAt, input.details],
    );

    const row = upsertResult.rows[0];
    // A fresh row (first occurrence, or a recurrence after resolution) always
    // starts at occurrence_count = 1 from the VALUES clause above; the
    // DO UPDATE branch always increments past 1. This distinguishes the two
    // cases without a second round-trip or relying on Postgres's internal
    // xmax system column.
    const isNew = row.occurrence_count === 1;

    const targetSeverity = severityForOccurrenceCount(row.occurrence_count, this.escalationThresholds);
    let finalRow = row;
    const escalated = targetSeverity !== (row.severity as OracleIncidentSeverity);
    if (escalated) {
      const escalateResult = await this.pool.query<IncidentRow>(
        `UPDATE oracle_incidents SET severity = $1, updated_at = now() WHERE id = $2 RETURNING *;`,
        [targetSeverity, row.id],
      );
      finalRow = escalateResult.rows[0];
    }

    return { incident: this.toIncident(finalRow), isNew, escalated };
  }

  async findMany(
    page = 1,
    limit = 20,
    status?: OracleIncidentStatus,
    cursor?: string,
  ): Promise<PaginatedResponse<OracleIncident>> {
    let offsetClause = '';
    let offsetParams: any[] = [];
    const queryParams: any[] = status ? [status] : [];
    let queryParams: any[] = status ? [status] : [];
    
    if (cursor) {
      const cursorDate = new Date(cursor).toISOString();
      offsetClause = `AND last_detected_at < $${queryParams.length + 1}`;
      queryParams.push(cursorDate);
      offsetParams = [limit];
    } else {
      const offset = (page - 1) * limit;
      offsetParams = [limit, offset];
    }
    
    const whereClause = status ? `WHERE status = $1 ${offsetClause}` : (cursor ? `WHERE last_detected_at < $1` : '');

    const [rowsResult, countResult] = await Promise.all([
      this.pool.query<IncidentRow>(
        `SELECT * FROM oracle_incidents ${whereClause}
         ORDER BY last_detected_at DESC
         LIMIT $${queryParams.length + 1} ${cursor ? '' : `OFFSET $${queryParams.length + 2}`};`,
        [...queryParams, ...offsetParams],
      ),
      this.pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM oracle_incidents ${status ? 'WHERE status = $1' : ''};`,
        status ? [status] : [],
      ),
    ]);

    const total = Number(countResult.rows[0].count);
    const data = rowsResult.rows.map((row) => this.toIncident(row));
    const nextCursor = data.length > 0 ? data[data.length - 1].lastDetectedAt : undefined;

    return {
      data,
      meta: cursor ? { limit, total, nextCursor, totalPages: Math.ceil(total / limit) } : { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findById(id: string): Promise<OracleIncident | null> {
    const result = await this.pool.query<IncidentRow>(
      `SELECT * FROM oracle_incidents WHERE id = $1;`,
      [id],
    );
    return result.rows[0] ? this.toIncident(result.rows[0]) : null;
  }

  async acknowledge(id: string, acknowledgedBy: string): Promise<OracleIncident> {
    const result = await this.pool.query<IncidentRow>(
      `
      UPDATE oracle_incidents
      SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2, updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING *;
      `,
      [id, acknowledgedBy],
    );
    if (result.rows.length === 0) {
      await this.assertExists(id);
      throw new NotFoundException(`Incident ${id} is not in an active state and cannot be acknowledged.`);
    }
    return this.toIncident(result.rows[0]);
  }

  async resolve(id: string, resolvedBy: string, resolutionNote?: string): Promise<OracleIncident> {
    const result = await this.pool.query<IncidentRow>(
      `
      UPDATE oracle_incidents
      SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution_note = $3, updated_at = now()
      WHERE id = $1 AND status <> 'resolved'
      RETURNING *;
      `,
      [id, resolvedBy, resolutionNote ?? null],
    );
    if (result.rows.length === 0) {
      await this.assertExists(id);
      throw new NotFoundException(`Incident ${id} is already resolved.`);
    }
    return this.toIncident(result.rows[0]);
  }

  private async assertExists(id: string): Promise<void> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new NotFoundException(`Incident ${id} not found.`);
    }
  }

  private toIncident(row: IncidentRow): OracleIncident {
    return {
      id: row.id,
      dedupeKey: row.dedupe_key,
      subjectType: row.subject_type as OracleIncident['subjectType'],
      subjectId: row.subject_id,
      status: row.status as OracleIncidentStatus,
      severity: row.severity as OracleIncidentSeverity,
      occurrenceCount: row.occurrence_count,
      firstDetectedAt: row.first_detected_at.toISOString(),
      lastDetectedAt: row.last_detected_at.toISOString(),
      acknowledgedAt: row.acknowledged_at ? row.acknowledged_at.toISOString() : null,
      acknowledgedBy: row.acknowledged_by,
      resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
      resolvedBy: row.resolved_by,
      resolutionNote: row.resolution_note,
      details: row.details,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
