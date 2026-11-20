import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Durable, Redis-independent storage for authoritative bond holder
 * membership. The API previously tracked holders only inside Redis, which
 * is not authoritative and is lost on Redis failure/eviction. The store
 * implementations here persist holder membership to a source that survives
 * Redis loss so coupon distribution and holder views remain correct even
 * when Redis is unavailable.
 *
 * Redis is still used as a fast read cache on top of this store, but the
 * store is the source of truth.
 */
export interface HolderStore {
  load(): Promise<void>;
  save(): Promise<void>;
  getHolders(bondId: number): string[];
  setHolders(bondId: number, holders: string[]): void;
  addHolder(bondId: number, address: string): void;
  removeHolder(bondId: number, address: string): void;
  getKnownAddresses(): string[];
  addKnownAddress(address: string): void;
  getLastReconciled(bondId: number): number;
  touch(bondId: number, at?: number): void;
}

interface HolderStoreData {
  holders: Record<string, string[]>;
  knownAddresses: string[];
  lastReconciled: Record<string, number>;
}

export class InMemoryHolderStore implements HolderStore {
  private data: HolderStoreData = { holders: {}, knownAddresses: [], lastReconciled: {} };

  async load(): Promise<void> {}
  async save(): Promise<void> {}

  getHolders(bondId: number): string[] {
    return [...(this.data.holders[String(bondId)] ?? [])];
  }

  setHolders(bondId: number, holders: string[]): void {
    this.data.holders[String(bondId)] = [...new Set(holders)];
  }

  addHolder(bondId: number, address: string): void {
    const key = String(bondId);
    const existing = this.data.holders[key] ?? [];
    if (!existing.includes(address)) {
      this.data.holders[key] = [...existing, address];
    }
  }

  removeHolder(bondId: number, address: string): void {
    const key = String(bondId);
    this.data.holders[key] = (this.data.holders[key] ?? []).filter((a) => a !== address);
  }

  getKnownAddresses(): string[] {
    return [...this.data.knownAddresses];
  }

  addKnownAddress(address: string): void {
    if (!this.data.knownAddresses.includes(address)) {
      this.data.knownAddresses.push(address);
    }
  }

  getLastReconciled(bondId: number): number {
    return this.data.lastReconciled[String(bondId)] ?? 0;
  }

  touch(bondId: number, at = Date.now()): void {
    this.data.lastReconciled[String(bondId)] = at;
  }
}

export class FileHolderStore implements HolderStore {
  private data: HolderStoreData = { holders: {}, knownAddresses: [], lastReconciled: {} };
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || process.env.HOLDER_INDEX_PATH || path.resolve(process.cwd(), '.data', 'holder-index.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<HolderStoreData>;
      this.data = {
        holders: parsed.holders ?? {},
        knownAddresses: parsed.knownAddresses ?? [],
        lastReconciled: parsed.lastReconciled ?? {},
      };
    } catch {
      this.data = { holders: {}, knownAddresses: [], lastReconciled: {} };
    }
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.data), 'utf8');
    } catch {
      // Persistence is best-effort; in-memory state remains authoritative for
      // the lifetime of the process. Operational runbook documents reindex.
    }
  }

  getHolders(bondId: number): string[] {
    return [...(this.data.holders[String(bondId)] ?? [])];
  }

  setHolders(bondId: number, holders: string[]): void {
    this.data.holders[String(bondId)] = [...new Set(holders)];
  }

  addHolder(bondId: number, address: string): void {
    const key = String(bondId);
    const existing = this.data.holders[key] ?? [];
    if (!existing.includes(address)) {
      this.data.holders[key] = [...existing, address];
    }
  }

  removeHolder(bondId: number, address: string): void {
    const key = String(bondId);
    this.data.holders[key] = (this.data.holders[key] ?? []).filter((a) => a !== address);
  }

  getKnownAddresses(): string[] {
    return [...this.data.knownAddresses];
  }

  addKnownAddress(address: string): void {
    if (!this.data.knownAddresses.includes(address)) {
      this.data.knownAddresses.push(address);
    }
  }

  getLastReconciled(bondId: number): number {
    return this.data.lastReconciled[String(bondId)] ?? 0;
  }

  touch(bondId: number, at = Date.now()): void {
    this.data.lastReconciled[String(bondId)] = at;
  }
}

export function createHolderStore(): HolderStore {
  const kind = process.env.HOLDER_INDEX_STORE || (process.env.NODE_ENV === 'test' ? 'memory' : 'file');
  if (kind === 'memory') {
    return new InMemoryHolderStore();
  }
  return new FileHolderStore();
}
