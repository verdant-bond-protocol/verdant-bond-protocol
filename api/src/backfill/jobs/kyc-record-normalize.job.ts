import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  KycStatus,
  KycStatusSource,
} from '../../common/interfaces/authenticated-request.interface';
import { RECORDS_FILE } from '../../common/services/kyc-store.service';
import {
  BackfillChange,
  BackfillDecision,
  BackfillJob,
  BackfillRefusedError,
  BackfillRestoreResult,
} from '../backfill.interface';

/** A record as found on disk: legacy rows may miss fields or use strings. */
export type StoredKycRecord = Record<string, unknown>;

interface StoredSnapshot {
  records: Record<string, StoredKycRecord>;
  audit?: unknown[];
  version?: number;
  [extra: string]: unknown;
}

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;
const STATUSES = new Set<string>(Object.values(KycStatus));
const SOURCES = new Set<KycStatusSource>(['provider', 'admin', 'system', 'import']);
const NULLABLE_FIELDS = ['actor', 'reason', 'providerReference'] as const;

/**
 * Normalises legacy KYC records in `kyc-records.json` to the current
 * `KycRecord` shape: absent nullable fields become `null`, a missing `source`
 * becomes `system`, and timestamps stored as ISO strings become epoch ms.
 *
 * It never changes `status`, so it writes no KYC audit entries — status
 * transitions are the only thing the audit log records. Fields outside the
 * `KycRecord` schema are left untouched.
 *
 * The KYC API keeps records in memory and rewrites the whole file, so this
 * job must run while the API is stopped. As a guard, every commit re-reads
 * the file and refuses to write if it changed since the job last saw it.
 */
export class KycRecordNormalizeJob implements BackfillJob<StoredKycRecord> {
  readonly id = 'kyc-record-normalize';
  readonly version = 1;
  readonly description =
    'Fill absent nullable KYC record fields with null, default missing source to "system", convert string timestamps to epoch ms.';
  readonly rollback =
    'npm run backfill -- rollback --job kyc-record-normalize --run <runId> restores journalled before-images; ' +
    'records edited after the backfill are reported as conflicts and left alone. ' +
    'Last resort: restore kyc-records.json from the pre-run copy (see docs/BACKFILL.md).';

  private readonly file: string;
  private snapshot: StoredSnapshot = { records: {} };
  private lastHash = '';

  constructor(dir = process.env.KYC_STORE_DIR || path.join(process.cwd(), 'data', 'kyc')) {
    this.file = path.join(dir, RECORDS_FILE);
  }

  get recordsFile(): string {
    return this.file;
  }

  async open(): Promise<void> {
    const { snapshot, hash } = this.read();
    this.snapshot = snapshot;
    this.lastHash = hash;
  }

  async listKeys(): Promise<string[]> {
    return Object.keys(this.snapshot.records);
  }

  async load(key: string): Promise<StoredKycRecord | null> {
    const record = this.snapshot.records[key];
    return record === undefined ? null : clone(record);
  }

  plan(key: string, record: StoredKycRecord): BackfillDecision<StoredKycRecord> {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('record is not an object');
    }
    if (typeof record.address !== 'string' || !STELLAR_ADDRESS.test(record.address)) {
      return { action: 'skip', reason: 'address is not a valid Stellar account id; needs manual review' };
    }
    if (record.address !== key) {
      return { action: 'skip', reason: 'record address does not match its key; needs manual review' };
    }
    if (typeof record.status !== 'string' || !STATUSES.has(record.status)) {
      throw new Error(`unknown status ${JSON.stringify(record.status)}`);
    }

    const after: StoredKycRecord = { ...record };
    const changes: string[] = [];
    const set = (field: string, value: unknown) => {
      changes.push(`${field}: ${show(record[field], field in record)} → ${show(value, true)}`);
      after[field] = value;
    };

    if (!('source' in record) || record.source === null) {
      set('source', 'system');
    } else if (!SOURCES.has(record.source as KycStatusSource)) {
      throw new Error(`unknown source ${JSON.stringify(record.source)}`);
    }

    for (const field of NULLABLE_FIELDS) {
      if (record[field] === undefined) set(field, null);
    }

    if (record.expiresAt === undefined) {
      set('expiresAt', null);
    } else if (record.expiresAt !== null) {
      const ms = toEpochMs(record.expiresAt, 'expiresAt');
      if (ms !== record.expiresAt) set('expiresAt', ms);
    }

    const created = record.createdAt == null ? null : toEpochMs(record.createdAt, 'createdAt');
    const updated = record.updatedAt == null ? null : toEpochMs(record.updatedAt, 'updatedAt');
    if (created === null && updated === null) {
      return { action: 'skip', reason: 'no createdAt or updatedAt to infer timestamps from' };
    }
    const createdAt = created ?? (updated as number);
    const updatedAt = updated ?? createdAt;
    if (createdAt !== record.createdAt) set('createdAt', createdAt);
    if (updatedAt !== record.updatedAt) set('updatedAt', updatedAt);

    return changes.length > 0 ? { action: 'update', after, changes } : { action: 'noop' };
  }

  async commit(changes: BackfillChange<StoredKycRecord>[]): Promise<void> {
    const { snapshot, hash } = this.read();
    if (hash !== this.lastHash) {
      throw new Error(
        `${RECORDS_FILE} changed on disk since the backfill read it (is the API running?). ` +
          'Nothing in this batch was written; stop writers and resume.',
      );
    }
    for (const change of changes) {
      if (!sameJson(snapshot.records[change.key], change.before)) {
        throw new Error(`record ${change.key} differs from its planned before-image`);
      }
      snapshot.records[change.key] = change.after;
    }
    this.write(snapshot);
  }

  async restore(changes: BackfillChange<StoredKycRecord>[]): Promise<BackfillRestoreResult> {
    const { snapshot } = this.read();
    const result: BackfillRestoreResult = { restored: [], conflicts: [] };
    for (const change of changes) {
      const current = snapshot.records[change.key];
      if (sameJson(current, change.after)) {
        snapshot.records[change.key] = change.before;
        result.restored.push(change.key);
      } else if (sameJson(current, change.before)) {
        // Batch journalled but never committed, or already rolled back.
        result.restored.push(change.key);
      } else {
        result.conflicts.push({
          key: change.key,
          reason: current === undefined ? 'record was deleted after the backfill' : 'record was modified after the backfill',
        });
      }
    }
    this.write(snapshot);
    return result;
  }

  private read(): { snapshot: StoredSnapshot; hash: string } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BackfillRefusedError(`${this.file} does not exist; check KYC_STORE_DIR.`);
      }
      throw error;
    }
    let parsed: StoredSnapshot;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new BackfillRefusedError(`${this.file} is not valid JSON: ${(error as Error).message}`);
    }
    if (!parsed || typeof parsed.records !== 'object' || parsed.records === null || Array.isArray(parsed.records)) {
      throw new BackfillRefusedError(`${this.file} has no "records" object.`);
    }
    return { snapshot: parsed, hash: sha256(raw) };
  }

  /** Same format and temp-file-then-rename as KycStoreService.writeSnapshot. */
  private write(snapshot: StoredSnapshot): void {
    const raw = JSON.stringify(snapshot, null, 2);
    const tmp = `${this.file}.tmp.${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, raw);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    this.snapshot = snapshot;
    this.lastHash = sha256(raw);
  }
}

function toEpochMs(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  throw new Error(`${field} is not a timestamp: ${JSON.stringify(value)}`);
}

function show(value: unknown, present: boolean): string {
  return present && value !== undefined ? JSON.stringify(value) : '<missing>';
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function sha256(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
