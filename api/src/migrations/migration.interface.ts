/**
 * Migration safety framework (issue #263).
 *
 * The repo has no migration tooling yet — schema creation today is
 * `CREATE TABLE IF NOT EXISTS` inside repositories (see
 * `oracle-incident.repository.ts` and `audit/audit-durable-store.ts`), which
 * is safe to re-run but gives contributors no way to preview what a change
 * will do, no way to know a partial rollout failed, and no written recovery
 * path. This module provides that guardrail for any future migration, and for
 * the ad-hoc DDL that already exists.
 */

export type MigrationPhase = 'dry-run' | 'apply' | 'post-check';

export interface MigrationAffected {
  /** Table or entity kind the change touches. */
  target: string;
  /** Rough estimate of rows involved, when cheap to produce. */
  estimate?: number;
  detail: string;
}

export interface MigrationPostCheck {
  name: string;
  /** Returns a failure description, or null when the check passes. */
  check: (context: Record<string, any>) => Promise<string | null>;
}

export interface MigrationDefinition {
  id: string;
  description: string;
  /** How to undo, or a forward-fix note when undo is not possible. */
  rollback: string;
  /** Preview of what will change, without writing anything. */
  dryRun: (context: Record<string, any>) => Promise<MigrationAffected[]>;
  /** The actual change. */
  apply: (context: Record<string, any>) => Promise<Record<string, any>>;
  /** Validations that must hold after the change. */
  postChecks?: MigrationPostCheck[];
}

export interface MigrationPostCheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface MigrationPhaseReport {
  phase: MigrationPhase;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  error?: string;
  affected?: MigrationAffected[];
  postCheckResults?: MigrationPostCheckResult[];
}

export interface MigrationRunReport {
  migrationId: string;
  dryRunOnly: boolean;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  phases: MigrationPhaseReport[];
  /** Filled when a phase failed so maintainers see the recorded recovery path. */
  rollbackNotes?: string;
}

export interface MigrationRecord {
  migrationId: string;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  dryRunOnly: boolean;
  affected: MigrationAffected[];
  postCheckResults: MigrationPostCheckResult[];
  rollbackNotes: string;
  error?: string;
}
