import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { OracleIncidentRepository } from '../oracle/oracle-incident.repository';
import { OracleIncidentStatus } from '../oracle/interfaces/oracle-incident.interface';
import { RECORDS_FILE as KYC_RECORDS_FILE } from '../common/services/kyc-store.service';

export enum DataType {
  TELEMETRY = 'telemetry',
  EXPORT = 'exports',
  EVIDENCE = 'evidence',
  AUDIT = 'kyc',
}

export const RETENTION_DAYS: Record<DataType, number> = {
  [DataType.TELEMETRY]: 30,
  [DataType.EXPORT]: 7,
  [DataType.EVIDENCE]: 365 * 5, // 5 years
  [DataType.AUDIT]: 365 * 7,    // 7 years
};

const DAY_MS = 1000 * 60 * 60 * 24;
/** Incidents read per page while building the evidence hold set. */
const HOLD_PAGE_SIZE = 100;

const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const roundAge = (age: number): number => Math.round(age * 100) / 100;

/**
 * Files that are live state rather than expiring records (#411). The KYC
 * store keeps its current records in `data/kyc`; that file is rewritten on
 * change, so a quiet period (or a restore that preserves old mtimes) must
 * never make it look "expired".
 */
const NEVER_EXPIRE: Partial<Record<DataType, ReadonlySet<string>>> = {
  [DataType.AUDIT]: new Set([KYC_RECORDS_FILE]),
};

export interface RetentionTypeReport {
  deleted: number;
  /** Past retention but kept: live state or under an incident hold. */
  held: number;
  errors: number;
}

export type RetentionRunReport = Record<DataType, RetentionTypeReport>;

/** Why a past-retention file was kept rather than deleted. */
export type RetentionHoldReason = 'never-expire' | 'evidence-hold';
export type RetentionAction = 'delete' | RetentionHoldReason;

/** One deterministic decision from `previewCleanup`. */
export interface RetentionPlanEntry {
  type: DataType;
  file: string;
  action: RetentionAction;
  ageDays: number;
}

/**
 * Read-only preview of what an enforcement run would do. Entries are sorted by
 * type then filename and contain no wall-clock timestamp, so two previews of an
 * unchanged directory are byte-identical.
 */
export interface RetentionPlan {
  entries: RetentionPlanEntry[];
}

/**
 * Evidence holds for one run: ids/subjects of unresolved incidents, or
 * `null` when they could not be loaded and every evidence file is held.
 */
type EvidenceHolds = string[] | null;

@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);
  private readonly dataDir: string;
  private readonly fileFs: typeof fs.promises;

  constructor(private readonly oracleIncidents: OracleIncidentRepository) {
    this.dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    this.fileFs = fs.promises;
  }

  /**
   * Deletes files past their retention period in the four classified
   * directories under DATA_DIR — nothing else, and no subdirectories. Safe to
   * re-run or run concurrently: a file already gone is not an error.
   *
   * Every file is stat-ed once (O(F)). Evidence holds are loaded at most once
   * per run — O(I / 100) queries for I unresolved incidents, instead of two
   * capped queries per file — and matched by substring, O(E·I) for E expired
   * evidence files.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async runCleanupJob(): Promise<RetentionRunReport> {
    this.logger.log('Starting data retention cleanup job...');
    const now = Date.now();
    const report = {} as RetentionRunReport;
    let holds: EvidenceHolds | undefined;

    for (const type of Object.values(DataType)) {
      const dirPath = path.join(this.dataDir, type);
      report[type] = await this.cleanupDirectory(dirPath, type, now, async () => (holds ??= await this.loadEvidenceHolds()));
    }

    this.logger.log('Data retention cleanup job finished.');
    return report;
  }

  /**
   * Read-only counterpart to `runCleanupJob` (#411). Uses the same retention
   * limits, the same never-expire allow-list and the same evidence-hold loader,
   * so the `delete` entries here are exactly the files enforcement removes.
   * It never unlinks anything.
   */
  async previewCleanup(): Promise<RetentionPlan> {
    const now = Date.now();
    const entries: RetentionPlanEntry[] = [];
    let holds: EvidenceHolds | undefined;

    for (const type of Object.values(DataType)) {
      const dirPath = path.join(this.dataDir, type);
      const files = await this.listFiles(dirPath);

      for (const file of [...files].sort(compareNames)) {
        const age = await this.fileAgeDays(path.join(dirPath, file), now);
        if (age === null || age <= RETENTION_DAYS[type]) continue;

        if (NEVER_EXPIRE[type]?.has(file)) {
          entries.push({ type, file, action: 'never-expire', ageDays: roundAge(age) });
          continue;
        }
        if (type === DataType.EVIDENCE && this.isHeld(file, await (holds ??= await this.loadEvidenceHolds()))) {
          entries.push({ type, file, action: 'evidence-hold', ageDays: roundAge(age) });
          continue;
        }
        entries.push({ type, file, action: 'delete', ageDays: roundAge(age) });
      }
    }

    entries.sort((a, b) => compareNames(a.type, b.type) || compareNames(a.file, b.file));
    return { entries };
  }

  /** Missing/unreadable directories contribute no files, as in enforcement. */
  private async listFiles(dirPath: string): Promise<string[]> {
    try {
      const stats = await this.fileFs.stat(dirPath);
      if (!stats.isDirectory()) return [];
    } catch {
      return [];
    }
    return this.fileFs.readdir(dirPath);
  }

  /** Returns null for non-files and stat failures; those are silently skipped. */
  private async fileAgeDays(filePath: string, now: number): Promise<number | null> {
    try {
      const stats = await this.fileFs.stat(filePath);
      if (!stats.isFile()) return null;
      return (now - stats.mtimeMs) / DAY_MS;
    } catch {
      return null;
    }
  }

  private async cleanupDirectory(
    dirPath: string,
    type: DataType,
    now: number,
    evidenceHolds: () => Promise<EvidenceHolds>,
  ): Promise<RetentionTypeReport> {
    const result: RetentionTypeReport = { deleted: 0, held: 0, errors: 0 };
    try {
      const stats = await this.fileFs.stat(dirPath);
      if (!stats.isDirectory()) return result;
    } catch (e) {
      // Directory doesn't exist, nothing to clean up
      return result;
    }

    const files = await this.fileFs.readdir(dirPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const fileStats = await this.fileFs.stat(filePath);
        if (!fileStats.isFile()) continue;

        const ageInDays = (now - fileStats.mtimeMs) / DAY_MS;
        if (ageInDays <= RETENTION_DAYS[type]) continue;

        if (NEVER_EXPIRE[type]?.has(file) || (type === DataType.EVIDENCE && this.isHeld(file, await evidenceHolds()))) {
          this.logger.log(`Skipping protected ${type} record: ${file}`);
          result.held++;
          continue;
        }

        this.logger.log(`Deleting expired ${type} record: ${file} (Age: ${ageInDays.toFixed(1)} days)`);
        await this.fileFs.unlink(filePath);
        result.deleted++;
      } catch (err) {
        // Already removed by a concurrent or earlier run: the goal is met.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        result.errors++;
        this.logger.error(`Error processing file ${filePath}: ${err}`);
      }
    }

    if (result.deleted > 0) {
      this.logger.log(`Deleted ${result.deleted} eligible records from ${type}.`);
    }
    return result;
  }

  private isHeld(filename: string, holds: EvidenceHolds): boolean {
    return holds === null || holds.some((key) => filename.includes(key));
  }

  /**
   * Every active or acknowledged incident, paged to the end — a hold must not
   * be lost just because there are more incidents than one page. Fails
   * closed: if the incidents cannot be read, all evidence is held this run.
   */
  private async loadEvidenceHolds(): Promise<EvidenceHolds> {
    try {
      const keys: string[] = [];
      for (const status of [OracleIncidentStatus.Active, OracleIncidentStatus.Acknowledged]) {
        let page = await this.oracleIncidents.findMany(1, HOLD_PAGE_SIZE, status);
        for (;;) {
          for (const incident of page.data) keys.push(incident.id, incident.subjectId);
          const cursor = page.meta.nextCursor;
          if (!cursor) break;
          page = await this.oracleIncidents.findMany(1, HOLD_PAGE_SIZE, status, String(cursor));
        }
      }
      return keys.filter(Boolean);
    } catch (err) {
      this.logger.warn(`Could not load incident holds; holding all expired evidence this run: ${err}`);
      return null;
    }
  }
}
