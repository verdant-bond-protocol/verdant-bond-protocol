import { Injectable } from '@nestjs/common';
import {
  SchemaVersion,
  applyReadTransforms,
  applyWriteTransforms,
  bondSchemaTransforms,
  isVersionSupported,
  validateRecordSchema,
} from './schema-versioning';
import type { CompatibilityRegistry, SchemaMetadata, VersionedRecord } from './schema-versioning';

/**
 * Admin-gated, retry-safe migration of versioned records (#contributor slice).
 *
 * The read/write transforms in `schema-versioning.ts` are pure but unguarded:
 * any caller could downgrade a financial record, and applying a transform twice
 * would stamp a fresh `migratedAt` on every retry. This service wraps them with
 * the three properties an operator needs when migrating stored records:
 *
 *   - **authorization**: only an admin may change a record's schema version;
 *   - **preflight**: a migration is refused unless every intermediate transform
 *     exists (a missing transform must never silently pass data through);
 *   - **retry/idempotency**: re-applying a completed migration is a no-op that
 *     returns the original record unchanged, so a retry after a lost reply is
 *     byte-for-byte stable and can be replayed safely.
 *
 * It is additive: the existing transform helpers and their contracts are left
 * untouched. Nothing is wired into request handling automatically; callers opt
 * in explicitly (e.g. an admin migration script). See
 * `docs/versioned-record-compatibility.md`.
 */

export const VERSION_ORDER: readonly SchemaVersion[] = [
  SchemaVersion.V1_0_0,
  SchemaVersion.V1_1_0,
  SchemaVersion.V1_2_0,
  SchemaVersion.V2_0_0,
];

export const MIGRATION_ADMIN_ROLE = 'admin';

export interface MigrationActor {
  readonly id: string;
  readonly roles: readonly string[];
}

export interface VersionedRecordMigrationRequest<T> {
  record: VersionedRecord<T>;
  targetVersion: SchemaVersion;
  /** Defaults to the bond registry. Inject a registry for other entities. */
  registry?: CompatibilityRegistry;
}

export interface VersionedRecordMigrationResult<T> {
  record: VersionedRecord<T>;
  /** True when the payload/data was actually rewritten. */
  changed: boolean;
  /** True when this call replayed a migration that had already completed. */
  replay: boolean;
  fromVersion: SchemaVersion;
  toVersion: SchemaVersion;
  /** Number of schema boundaries crossed (0 for a replay). */
  transformsApplied: number;
}

export type RecordMigrationErrorCode =
  | 'migration_forbidden'
  | 'invalid_record'
  | 'unsupported_version'
  | 'missing_transform';

export class RecordMigrationError extends Error {
  constructor(
    message: string,
    readonly code: RecordMigrationErrorCode,
  ) {
    super(message);
    this.name = 'RecordMigrationError';
  }
}

@Injectable()
export class VersionedRecordMigrationService {
  /** `now` is injectable so a retry can be asserted to be byte-identical. */
  constructor(private readonly now: () => number = Date.now) {}

  migrate<T>(
    request: VersionedRecordMigrationRequest<T>,
    actor: MigrationActor,
  ): VersionedRecordMigrationResult<T> {
    this.authorize(actor);

    const { record, targetVersion, registry = bondSchemaTransforms } = request;
    const check = validateRecordSchema(record);
    if (!check.supported) {
      throw new RecordMigrationError(check.message, 'invalid_record');
    }
    if (!isVersionSupported(targetVersion)) {
      throw new RecordMigrationError(
        `Target schema version ${targetVersion} is not supported`,
        'unsupported_version',
      );
    }

    const fromVersion = record.metadata.version;
    const fromIndex = VERSION_ORDER.indexOf(fromVersion);
    const toIndex = VERSION_ORDER.indexOf(targetVersion);
    if (fromIndex < 0 || toIndex < 0) {
      // validateRecordSchema already rejects unknown versions, but a registry
      // may declare a version the order table has not been taught yet.
      throw new RecordMigrationError(
        `Cannot order migration ${fromVersion} -> ${targetVersion}`,
        'unsupported_version',
      );
    }

    // Retry of an already-completed migration: return the exact same envelope
    // (including its original migratedAt) rather than restamping it.
    if (fromIndex === toIndex) {
      return {
        record,
        changed: false,
        replay: true,
        fromVersion,
        toVersion: targetVersion,
        transformsApplied: 0,
      };
    }

    const isUpgrade = fromIndex < toIndex;
    this.assertTransformsAvailable(fromVersion, targetVersion, registry, isUpgrade);

    const data = isUpgrade
      ? applyReadTransforms<T>(record.data, fromVersion, registry)
      : applyWriteTransforms<T>(record.data, targetVersion, registry);

    const metadata: SchemaMetadata = {
      ...record.metadata,
      version: targetVersion,
      migratedFrom: fromVersion,
      migratedAt: this.now(),
      deprecated: false,
    };

    return {
      record: { metadata, data },
      changed: true,
      replay: false,
      fromVersion,
      toVersion: targetVersion,
      transformsApplied: Math.abs(toIndex - fromIndex),
    };
  }

  private authorize(actor: MigrationActor): void {
    if (!actor || !actor.id || !actor.roles?.includes(MIGRATION_ADMIN_ROLE)) {
      throw new RecordMigrationError(
        `Actor ${actor?.id ?? '<anonymous>'} is not authorized to migrate schema versions`,
        'migration_forbidden',
      );
    }
  }

  private assertTransformsAvailable<T>(
    from: SchemaVersion,
    to: SchemaVersion,
    registry: CompatibilityRegistry,
    isUpgrade: boolean,
  ): void {
    const fromIndex = VERSION_ORDER.indexOf(from);
    const toIndex = VERSION_ORDER.indexOf(to);
    if (isUpgrade) {
      const missing = VERSION_ORDER.slice(fromIndex, toIndex).find(
        (version) => !registry.readTransforms.some((t) => t.fromVersion === version),
      );
      if (missing) {
        throw new RecordMigrationError(
          `No read transform from ${missing}; refusing to pass data through unchanged`,
          'missing_transform',
        );
      }
      return;
    }
    if (!registry.writeTransforms.some((t) => t.toVersion === to)) {
      // V2.0.0 is the canonical latest shape and legitimately needs no write
      // transform; every older target must have one.
      if (to !== SchemaVersion.V2_0_0) {
        throw new RecordMigrationError(
          `No write transform to ${to}; refusing to pass data through unchanged`,
          'missing_transform',
        );
      }
    }
  }
}
