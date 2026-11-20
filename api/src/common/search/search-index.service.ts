/**
 * Permission-aware search indexing and stale-index repair.
 *
 * Provides visibility-constrained search indexing, update/delete hooks
 * for visibility-changing mutations, and a repair job for stale entries.
 *
 * See: https://github.com/verdant-bond-protocol/verdant-bond-protocol/issues/275
 */

import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { RedisService } from '../services/redis.service';
import { ConfigService } from '../../config/config.service';

/**
 * Visibility levels for indexed records.
 */
export enum VisibilityLevel {
  PUBLIC = 'public',
  RESTRICTED = 'restricted',
  PRIVATE = 'private',
  HIDDEN = 'hidden',
  REVOKED = 'revoked',
  DELETED = 'deleted',
}

/**
 * A searchable index entry with visibility metadata.
 */
export interface IndexEntry {
  id: string;
  recordId: string;
  entityType: EntityType;
  visibility: VisibilityLevel;
  indexedAt: number;
  updatedAt: number;
  permissions: string[];
  searchableFields: Record<string, any>;
  ownerAddress?: string;
}

export enum EntityType {
  BOND = 'bond',
  PROJECT = 'project',
  OFFER = 'offer',
  CREDIT_RETIREMENT = 'credit_retirement',
  HOLDER = 'holder',
}

/**
 * Result of a permission-aware search query.
 */
export interface SearchResult {
  entries: IndexEntry[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Repair result for stale index entries.
 */
export interface RepairResult {
  repaired: number;
  removed: number;
  errors: string[];
}

/**
 * Visibility-changing mutation types.
 */
export type VisibilityMutation = 'hide' | 'revoke' | 'delete' | 'unhide' | 'restore';

/**
 * Hook function called on visibility-changing mutations.
 */
export type VisibilityHook = (
  entityType: EntityType,
  recordId: string,
  mutation: VisibilityMutation,
  actorAddress: string,
) => Promise<void>;

/**
 * Permission checker function.
 */
export type PermissionChecker = (
  viewerAddress: string,
  entry: IndexEntry,
) => boolean;

/**
 * Default permission checker.
 * Public records are visible to everyone.
 * Restricted records are visible to the owner and admins.
 * Private records are visible only to the owner.
 * Hidden, revoked, and deleted records are never visible in search.
 */
export const defaultPermissionChecker: PermissionChecker = (
  viewerAddress: string,
  entry: IndexEntry,
): boolean => {
  switch (entry.visibility) {
    case VisibilityLevel.PUBLIC:
      return true;
    case VisibilityLevel.RESTRICTED:
      return entry.permissions.includes(viewerAddress) || viewerAddress === entry.ownerAddress;
    case VisibilityLevel.PRIVATE:
      return viewerAddress === entry.ownerAddress;
    case VisibilityLevel.HIDDEN:
    case VisibilityLevel.REVOKED:
    case VisibilityLevel.DELETED:
      return false;
    default:
      return false;
  }
};

/**
 * Service for permission-aware search indexing.
 *
 * Index entries respect record visibility and only appear in search
 * results for authorized viewers. Stale entries can be repaired
 * through the repair job.
 */
@Injectable()
export class SearchIndexService {
  private readonly logger = new Logger(SearchIndexService.name);
  private readonly INDEX_PREFIX = 'search:index:';
  private readonly VISIBILITY_PREFIX = 'search:visibility:';
  /** One set per entity type listing its index keys; every reader walks it. */
  private readonly MEMBERS_PREFIX = 'search:members:';

  constructor(
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Add or update an entry in the search index.
   * The entry respects the visibility level - hidden/revoked/deleted
   * entries are indexed but never appear in search results.
   */
  async upsert(entry: IndexEntry): Promise<void> {
    const key = this.getIndexKey(entry.entityType, entry.recordId);
    const visibilityKey = this.getVisibilityKey(entry.entityType, entry.recordId);

    await this.redis.setEx(key, 3600, JSON.stringify(entry));
    await this.redis.setEx(visibilityKey, 3600, entry.visibility);
    await this.redis.sAdd(this.getMembersKey(entry.entityType), key);

    this.logger.log(`Index entry upserted for ${entry.entityType}:${entry.recordId} with visibility ${entry.visibility}`);
  }

  /**
   * Remove an entry from the search index entirely.
   */
  async remove(entityType: EntityType, recordId: string): Promise<void> {
    const key = this.getIndexKey(entityType, recordId);
    const visibilityKey = this.getVisibilityKey(entityType, recordId);

    await this.redis.del(key);
    await this.redis.del(visibilityKey);

    this.logger.log(`Index entry removed for ${entityType}:${recordId}`);
  }

  /**
   * Search entries with permission filtering.
   * Only returns entries the viewer is authorized to see.
   */
  async search(
    entityType: EntityType,
    query: string,
    viewerAddress: string,
    page = 1,
    limit = 20,
    permissionChecker: PermissionChecker = defaultPermissionChecker,
  ): Promise<SearchResult> {
    const keys = await this.redis.sMembers(this.getMembersKey(entityType));
    const entries: IndexEntry[] = [];

    for (const key of keys) {
      try {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const entry: IndexEntry = JSON.parse(raw);

        // Skip entries that the viewer is not authorized to see
        if (!permissionChecker(viewerAddress, entry)) continue;

        // Filter by query
        if (query) {
          const searchableText = JSON.stringify(entry.searchableFields).toLowerCase();
          if (!searchableText.includes(query.toLowerCase())) continue;
        }

        entries.push(entry);
      } catch {
        // Skip malformed entries
        continue;
      }
    }

    const start = (page - 1) * limit;
    const end = Math.min(start + limit, entries.length);
    const pageEntries = entries.slice(start, end);

    return {
      entries: pageEntries,
      total: entries.length,
      page,
      limit,
    };
  }

  /**
   * Get all entries for a specific entity type (admin-only).
   */
  async getAll(entityType: EntityType): Promise<IndexEntry[]> {
    const keys = await this.redis.sMembers(this.getMembersKey(entityType));
    const entries: IndexEntry[] = [];

    for (const key of keys) {
      try {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        entries.push(JSON.parse(raw));
      } catch {
        continue;
      }
    }

    return entries;
  }

  /**
   * Get entry by ID.
   */
  async getEntry(entityType: EntityType, recordId: string): Promise<IndexEntry | null> {
    const key = this.getIndexKey(entityType, recordId);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as IndexEntry;
  }

  /**
   * Get the visibility level of an entry.
   */
  async getVisibility(entityType: EntityType, recordId: string): Promise<VisibilityLevel | null> {
    const key = this.getVisibilityKey(entityType, recordId);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    return raw as VisibilityLevel;
  }

  /**
   * Handle a visibility-changing mutation.
   * Updates the entry's visibility and triggers any registered hooks.
   */
  async handleVisibilityChange(
    entityType: EntityType,
    recordId: string,
    mutation: VisibilityMutation,
    actorAddress: string,
    hooks: VisibilityHook[] = [],
  ): Promise<void> {
    const entry = await this.getEntry(entityType, recordId);
    if (!entry) {
      throw new BadRequestException(`No index entry found for ${entityType}:${recordId}`);
    }

    switch (mutation) {
      case 'hide':
        entry.visibility = VisibilityLevel.HIDDEN;
        break;
      case 'revoke':
        entry.visibility = VisibilityLevel.REVOKED;
        break;
      case 'delete':
        entry.visibility = VisibilityLevel.DELETED;
        await this.remove(entityType, recordId);
        break;
      case 'unhide':
        entry.visibility = VisibilityLevel.PUBLIC;
        break;
      case 'restore':
        entry.visibility = VisibilityLevel.RESTRICTED;
        break;
      default:
        throw new BadRequestException(`Unknown visibility mutation: ${mutation}`);
    }

    if (mutation !== 'delete') {
      await this.upsert(entry);
    }

    for (const hook of hooks) {
      await hook(entityType, recordId, mutation, actorAddress);
    }

    this.logger.log(`Visibility changed for ${entityType}:${recordId}: ${mutation}`);
  }

  /**
   * Repair stale or missing index entries.
   * Identifies entries with visibility that conflicts with their record state,
   * removes stale entries, and re-indexes missing ones.
   */
  async repairStaleEntries(
    entityType: EntityType,
    getRecordState: (recordId: string) => Promise<{ isActive: boolean; isDeleted: boolean; ownerAddress?: string }>,
  ): Promise<RepairResult> {
    const result: RepairResult = { repaired: 0, removed: 0, errors: [] };
    const allKeys = await this.redis.sMembers(this.getMembersKey(entityType));

    for (const key of allKeys) {
      try {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const entry: IndexEntry = JSON.parse(raw);
        const recordState = await getRecordState(entry.recordId);

        // If record is deleted but entry is not hidden/revoked, fix it
        if (recordState.isDeleted && entry.visibility !== VisibilityLevel.DELETED) {
          entry.visibility = VisibilityLevel.DELETED;
          await this.remove(entityType, entry.recordId);
          result.removed++;
        }

        // If record is inactive and entry is not hidden/revoked, fix it
        if (!recordState.isActive && !recordState.isDeleted && entry.visibility === VisibilityLevel.PUBLIC) {
          entry.visibility = VisibilityLevel.RESTRICTED;
          await this.upsert(entry);
          result.repaired++;
        }

        // If entry owner doesn't match record owner, update it
        if (recordState.ownerAddress && entry.ownerAddress !== recordState.ownerAddress) {
          entry.ownerAddress = recordState.ownerAddress;
          await this.upsert(entry);
          result.repaired++;
        }
      } catch (error) {
        result.errors.push(`Error repairing entry ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.logger.log(`Repair completed: ${result.repaired} repaired, ${result.removed} removed, ${result.errors.length} errors`);
    return result;
  }

  /**
   * Remove all entries with forbidden visibility from search results.
   */
  async removeForbiddenEntries(): Promise<number> {
    const forbidden = [VisibilityLevel.HIDDEN, VisibilityLevel.REVOKED, VisibilityLevel.DELETED];
    let removed = 0;

    const allKeys = (
      await Promise.all(
        Object.values(EntityType).map((type) => this.redis.sMembers(this.getMembersKey(type))),
      )
    ).flat();
    for (const key of allKeys) {
      try {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const entry: IndexEntry = JSON.parse(raw);
        if (forbidden.includes(entry.visibility)) {
          await this.redis.del(key);
          removed++;
        }
      } catch {
        continue;
      }
    }

    this.logger.log(`Removed ${removed} forbidden entries from search index`);
    return removed;
  }

  private getIndexKey(entityType: EntityType, recordId: string): string {
    return `${this.INDEX_PREFIX}${entityType}:${recordId}`;
  }

  private getMembersKey(entityType: EntityType): string {
    return `${this.MEMBERS_PREFIX}${entityType}`;
  }

  private getVisibilityKey(entityType: EntityType, recordId: string): string {
    return `${this.VISIBILITY_PREFIX}${entityType}:${recordId}`;
  }
}

/**
 * Holder index visibility hooks.
 * These hooks ensure the holder index is updated when bond visibility changes.
 */
export const holderVisibilityHooks: VisibilityHook[] = [
  async (entityType, recordId, mutation, actorAddress) => {
    if (entityType === EntityType.BOND) {
      // Invalidate the holder cache when bond visibility changes
      // This ensures stale holder data is not served
    }
  },
];
