import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  KycAuditEntry,
  KycRecord,
  KycStatus,
  KycStatusSource,
} from '../interfaces/authenticated-request.interface';

interface KycStoreSnapshot {
  records: Record<string, KycRecord>;
  audit: KycAuditEntry[];
  version: number;
}

/** Live KYC state; the retention job must never expire it (#411). */
export const RECORDS_FILE = 'kyc-records.json';
const AUDIT_FILE = 'kyc-audit.log.jsonl';

const SNAPSHOT_EMPTY: KycStoreSnapshot = {
  records: {},
  audit: [],
  version: 1,
};

@Injectable()
export class KycStoreService implements OnModuleInit {
  private readonly logger = new Logger(KycStoreService.name);
  private readonly recordsPath: string;
  private readonly auditPath: string;
  private readonly dir: string;
  private readonly fileFs: typeof fs.promises;
  private records: Record<string, KycRecord> = {};
  private writeLock: Promise<void> = Promise.resolve();

  constructor() {
    this.dir = process.env.KYC_STORE_DIR || path.join(process.cwd(), 'data', 'kyc');
    this.recordsPath = path.join(this.dir, RECORDS_FILE);
    this.auditPath = path.join(this.dir, AUDIT_FILE);
    this.fileFs = fs.promises;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.fileFs.mkdir(this.dir, { recursive: true });
    } catch (error) {
      this.logger.warn(
        `KYC store mkdir failed for ${this.dir}: ${this.message(error)} — using in-memory only. Deploy a persistent volume to keep KYC state.`,
      );
    }
    await this.loadSnapshot();
  }

  async get(address: string): Promise<KycRecord | null> {
    return this.records[address] ?? null;
  }

  async list(): Promise<KycRecord[]> {
    return Object.values(this.records);
  }

  async listAudit(address?: string, limit = 100): Promise<KycAuditEntry[]> {
    const all = await this.readAuditTail(limit * 10);
    const filtered = address
      ? all.filter((e) => e.address === address)
      : all;
    return filtered.slice(-limit);
  }

  async applyTransition(input: {
    address: string;
    toStatus: KycStatus;
    source: KycStatusSource;
    actor?: string | null;
    reason?: string | null;
    providerReference?: string | null;
    expiresAt?: number | null;
  }): Promise<{ record: KycRecord; entry: KycAuditEntry; isNew: boolean }> {
    const existing = this.records[input.address] ?? null;
    const now = Date.now();

    if (
      existing &&
      existing.status === input.toStatus &&
      (existing.expiresAt ?? null) === (input.expiresAt ?? null)
    ) {
      return { record: existing, entry: {} as KycAuditEntry, isNew: false };
    }

    const entry: KycAuditEntry = {
      id: crypto.randomBytes(16).toString('hex'),
      address: input.address,
      fromStatus: existing?.status ?? KycStatus.PENDING,
      toStatus: input.toStatus,
      source: input.source,
      actor: input.actor ?? null,
      reason: input.reason ?? null,
      providerReference: input.providerReference ?? null,
      expiresAt: input.expiresAt ?? null,
      timestamp: now,
    };

    const record: KycRecord = existing
      ? {
          ...existing,
          status: input.toStatus,
          source: input.source,
          actor: input.actor ?? existing.actor,
          reason: input.reason ?? existing.reason,
          providerReference: input.providerReference ?? existing.providerReference,
          expiresAt: input.expiresAt ?? existing.expiresAt,
          updatedAt: now,
        }
      : {
          address: input.address,
          status: input.toStatus,
          source: input.source,
          actor: input.actor ?? null,
          reason: input.reason ?? null,
          providerReference: input.providerReference ?? null,
          createdAt: now,
          updatedAt: now,
          expiresAt: input.expiresAt ?? null,
        };

    this.records[input.address] = record;
    await this.persist(record, entry);

    return { record, entry, isNew: !existing };
  }

  private async persist(
    record: KycRecord,
    entry: KycAuditEntry,
  ): Promise<void> {
    this.writeLock = this.writeLock.then(async () => {
      try {
        await Promise.all([
          this.appendAuditLine(entry),
          this.writeSnapshot(),
        ]);
      } catch (error) {
        this.logger.error(
          `KYC store persist failed for ${record.address}: ${this.message(error)}. In-memory state has been updated; durable storage is inconsistent.`,
        );
      }
    });
    await this.writeLock;
  }

  private async loadSnapshot(): Promise<void> {
    try {
      const raw = await this.fileFs.readFile(this.recordsPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<KycStoreSnapshot>;
      this.records = parsed?.records ?? {};
    } catch (error) {
      if (this.isEnoent(error)) {
        this.records = {};
        return;
      }
      this.logger.warn(
        `Failed to load KYC records snapshot: ${this.message(error)}. Replaying audit log if available.`,
      );
      this.records = {};
    }
    try {
      await this.replayAudit();
    } catch (error) {
      this.logger.warn(
        `Failed to replay KYC audit log: ${this.message(error)}. Proceeding with snapshot state.`,
      );
    }
  }

  private async replayAudit(): Promise<void> {
    let lines: string[];
    try {
      const raw = await this.fileFs.readFile(this.auditPath, 'utf8');
      lines = raw.split('\n').filter((l) => l.trim() !== '');
    } catch (error) {
      if (this.isEnoent(error)) return;
      throw error;
    }
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as KycAuditEntry;
        const existing = this.records[entry.address];
        this.records[entry.address] = existing
          ? {
              ...existing,
              status: entry.toStatus,
              source: entry.source,
              actor: entry.actor ?? existing.actor,
              reason: entry.reason ?? existing.reason,
              providerReference: entry.providerReference ?? existing.providerReference,
              expiresAt: entry.expiresAt ?? existing.expiresAt,
              updatedAt: entry.timestamp,
            }
          : {
              address: entry.address,
              status: entry.toStatus,
              source: entry.source,
              actor: entry.actor ?? null,
              reason: entry.reason ?? null,
              providerReference: entry.providerReference ?? null,
              createdAt: entry.timestamp,
              updatedAt: entry.timestamp,
              expiresAt: entry.expiresAt ?? null,
            };
      } catch (error) {
        this.logger.warn(
          `Skipping unparseable KYC audit line: ${this.message(error)}`,
        );
      }
    }
  }

  private async appendAuditLine(entry: KycAuditEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    try {
      await this.fileFs.appendFile(this.auditPath, line, 'utf8');
    } catch (error) {
      throw error;
    }
  }

  private async writeSnapshot(): Promise<void> {
    const snapshot: KycStoreSnapshot = {
      records: this.records,
      audit: [],
      version: SNAPSHOT_EMPTY.version,
    };
    const tmp = `${this.recordsPath}.tmp.${process.pid}`;
    try {
      await this.fileFs.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      await this.fileFs.rename(tmp, this.recordsPath);
    } catch (error) {
      try {
        await this.fileFs.unlink(tmp).catch(() => undefined);
      } catch {
        // ignore cleanup errors
      }
      throw error;
    }
  }

  private async readAuditTail(maxBytes = 1_000_000): Promise<KycAuditEntry[]> {
    let raw: string;
    try {
      const stat = await this.fileFs.stat(this.auditPath);
      const size = stat.size;
      const start = Math.max(0, size - maxBytes);
      const handle = await this.fileFs.open(this.auditPath, 'r');
      try {
        const buf = Buffer.alloc(Math.min(maxBytes, size));
        await handle.read(buf, 0, buf.length, start);
        raw = buf.toString('utf8');
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (error) {
      if (this.isEnoent(error)) return [];
      throw error;
    }
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    // If we started mid-file, the first line may be a partial record; drop it
    if (raw.length >= maxBytes && lines.length > 0) lines.shift();
    const out: KycAuditEntry[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as KycAuditEntry);
      } catch {
        // skip unparseable
      }
    }
    return out;
  }

  private isEnoent(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
